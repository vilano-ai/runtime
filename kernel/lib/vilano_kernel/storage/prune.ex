defmodule VilanoKernel.Storage.Prune do
  @moduledoc false

  import Bitwise

  alias VilanoKernel.Storage
  alias VilanoKernel.Storage.EventPayloads
  alias VilanoKernel.Storage.Usage

  @default_run_workspace_ttl_seconds 86_400
  @default_event_payload_grace_seconds 300
  @default_project_snapshot_grace_seconds 300

  def prune_runtime(opts \\ %{}) do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)

    with {:ok, dry_run?} <- boolean_option(opts, "dryRun", :dry_run, false),
         {:ok, project_snapshot_grace_seconds} <-
           non_negative_integer(
             opts,
             "projectSnapshotGraceSeconds",
             :project_snapshot_grace_seconds,
             @default_project_snapshot_grace_seconds
           ),
         {:ok, run_workspace_ttl_seconds} <-
           non_negative_integer(
             opts,
             "runWorkspaceTtlSeconds",
             :run_workspace_ttl_seconds,
             @default_run_workspace_ttl_seconds
           ),
         {:ok, event_payload_grace_seconds} <-
           non_negative_integer(
             opts,
             "eventPayloadGraceSeconds",
             :event_payload_grace_seconds,
             @default_event_payload_grace_seconds
           ) do
      %{
        ok: true,
        dryRun: dry_run?,
        prunedAt: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601(),
        projectSnapshots:
          prune_project_snapshots(runtime, project_snapshot_grace_seconds, dry_run?),
        runWorkspaces: prune_run_workspaces(runtime, run_workspace_ttl_seconds, dry_run?),
        eventPayloads: prune_event_payloads(event_payload_grace_seconds, dry_run?)
      }
    else
      {:error, message} ->
        %{
          ok: false,
          error: %{
            code: "invalid_prune_option",
            message: message
          }
        }
    end
  end

  defp prune_project_snapshots(runtime, grace_seconds, dry_run?) do
    root = Path.join(runtime.execution_home_dir, "project-snapshots")
    retained = Storage.list_referenced_snapshot_paths(nil) |> MapSet.new(&Path.expand/1)
    now_seconds = System.system_time(:second)

    candidates =
      root
      |> child_directories()
      |> Enum.flat_map(&child_directories/1)
      |> Enum.reject(&(Path.expand(&1) in retained))
      |> Enum.filter(&older_than?(&1, now_seconds, grace_seconds))
      |> Enum.map(&candidate_summary/1)

    removals = remove_candidates(candidates, dry_run?)

    %{
      "root" => root,
      "graceSeconds" => grace_seconds,
      "candidateCount" => length(candidates),
      "candidateBytes" => sum_candidate_bytes(candidates),
      "removedCount" => removed_count(removals),
      "removedBytes" => removed_bytes(removals),
      "failedCount" => failed_count(removals),
      "failedBytes" => failed_bytes(removals),
      "failedPaths" => failed_paths(removals)
    }
  end

  defp prune_run_workspaces(runtime, ttl_seconds, dry_run?) do
    root = Path.join([runtime.execution_home_dir, "worker-home", "run-workspaces"])
    active_lease_ids = Storage.list_active_leases() |> MapSet.new(& &1["leaseId"])
    now_seconds = System.system_time(:second)

    candidates =
      root
      |> child_directories()
      |> Enum.reject(&(Path.basename(&1) in active_lease_ids))
      |> Enum.filter(&older_than?(&1, now_seconds, ttl_seconds))
      |> Enum.map(&candidate_summary/1)

    removals = remove_candidates(candidates, dry_run?)

    %{
      "root" => root,
      "ttlSeconds" => ttl_seconds,
      "candidateCount" => length(candidates),
      "candidateBytes" => sum_candidate_bytes(candidates),
      "removedCount" => removed_count(removals),
      "removedBytes" => removed_bytes(removals),
      "failedCount" => failed_count(removals),
      "failedBytes" => failed_bytes(removals),
      "failedPaths" => failed_paths(removals)
    }
  end

  defp prune_event_payloads(grace_seconds, true) do
    %{
      "graceSeconds" => grace_seconds,
      "garbageCollected" => false
    }
  end

  defp prune_event_payloads(grace_seconds, false) do
    EventPayloads.garbage_collect!(grace_seconds * 1_000)

    %{
      "graceSeconds" => grace_seconds,
      "garbageCollected" => true
    }
  end

  defp child_directories(root) do
    case File.ls(root) do
      {:ok, entries} ->
        entries
        |> Enum.map(&Path.join(root, &1))
        |> Enum.filter(&directory?/1)

      {:error, :enoent} ->
        []

      {:error, _reason} ->
        []
    end
  end

  defp directory?(path) do
    case File.lstat(path) do
      {:ok, %{type: :directory}} -> true
      _ -> false
    end
  end

  defp older_than?(path, now_seconds, ttl_seconds) do
    case File.lstat(path, time: :posix) do
      {:ok, %{mtime: mtime_seconds}} when is_integer(mtime_seconds) ->
        now_seconds - mtime_seconds >= ttl_seconds

      _ ->
        false
    end
  end

  defp candidate_summary(path) do
    usage = Usage.path_usage(path)

    %{
      "path" => path,
      "bytes" => usage["bytes"],
      "files" => usage["files"],
      "directories" => usage["directories"]
    }
  end

  defp remove_candidates(candidates, true) do
    Enum.map(candidates, &Map.put(&1, "removalStatus", "dry_run"))
  end

  defp remove_candidates(candidates, false) do
    Enum.map(candidates, fn %{"path" => path} = candidate ->
      make_writable_for_removal(path)

      case File.rm_rf(path) do
        {:ok, removed_paths} when removed_paths != [] ->
          Map.merge(candidate, %{"removalStatus" => "removed"})

        {:ok, _removed_paths} ->
          Map.merge(candidate, %{"removalStatus" => "missing"})

        {:error, reason, failed_path} ->
          Map.merge(candidate, %{
            "removalStatus" => "failed",
            "failedPath" => failed_path,
            "failureReason" => reason
          })
      end
    end)
  end

  defp make_writable_for_removal(path) do
    case File.lstat(path) do
      {:ok, %{type: :directory, mode: mode}} ->
        path
        |> child_directories()
        |> Enum.each(&make_writable_for_removal/1)

        File.chmod(path, mode ||| 0o200)

      {:ok, %{type: :regular, mode: mode}} ->
        File.chmod(path, mode ||| 0o200)

      _ ->
        :ok
    end
  end

  defp sum_candidate_bytes(candidates) do
    Enum.reduce(candidates, 0, &(&2 + &1["bytes"]))
  end

  defp removed_count(removals), do: Enum.count(removals, &(&1["removalStatus"] == "removed"))

  defp removed_bytes(removals) do
    removals
    |> Enum.filter(&(&1["removalStatus"] == "removed"))
    |> sum_candidate_bytes()
  end

  defp failed_count(removals), do: Enum.count(removals, &(&1["removalStatus"] == "failed"))

  defp failed_bytes(removals) do
    removals
    |> Enum.filter(&(&1["removalStatus"] == "failed"))
    |> sum_candidate_bytes()
  end

  defp failed_paths(removals) do
    removals
    |> Enum.filter(&(&1["removalStatus"] == "failed"))
    |> Enum.map(fn removal ->
      %{
        "path" => removal["path"],
        "failedPath" => to_string(removal["failedPath"]),
        "reason" => to_string(removal["failureReason"]),
        "bytes" => removal["bytes"]
      }
    end)
  end

  defp non_negative_integer(opts, string_key, atom_key, default) do
    case fetch_option(opts, string_key, atom_key) do
      :missing ->
        {:ok, default}

      value when is_integer(value) and value >= 0 ->
        {:ok, value}

      _value ->
        {:error, "#{string_key} must be a non-negative integer"}
    end
  end

  defp fetch_option(opts, string_key, atom_key) do
    case Map.fetch(opts, string_key) do
      {:ok, value} ->
        value

      :error ->
        case Map.fetch(opts, atom_key) do
          {:ok, value} -> value
          :error -> :missing
        end
    end
  end

  defp boolean_option(opts, string_key, atom_key, default) do
    case fetch_option(opts, string_key, atom_key) do
      :missing -> {:ok, default}
      value when is_boolean(value) -> {:ok, value}
      _value -> {:error, "#{string_key} must be a boolean"}
    end
  end
end
