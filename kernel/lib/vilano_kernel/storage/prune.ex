defmodule VilanoKernel.Storage.Prune do
  @moduledoc false

  import Bitwise

  alias VilanoKernel.Storage
  alias VilanoKernel.Storage.EventPayloads
  alias VilanoKernel.Storage.Usage

  @default_run_workspace_ttl_seconds 86_400
  @default_event_payload_grace_seconds 300

  def prune_runtime(opts \\ %{}) do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    dry_run? = truthy?(Map.get(opts, "dryRun", Map.get(opts, :dry_run, false)))

    run_workspace_ttl_seconds =
      non_negative_integer(
        Map.get(opts, "runWorkspaceTtlSeconds", Map.get(opts, :run_workspace_ttl_seconds)),
        @default_run_workspace_ttl_seconds
      )

    event_payload_grace_seconds =
      non_negative_integer(
        Map.get(opts, "eventPayloadGraceSeconds", Map.get(opts, :event_payload_grace_seconds)),
        @default_event_payload_grace_seconds
      )

    %{
      ok: true,
      dryRun: dry_run?,
      prunedAt: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601(),
      projectSnapshots: prune_project_snapshots(runtime, dry_run?),
      runWorkspaces: prune_run_workspaces(runtime, run_workspace_ttl_seconds, dry_run?),
      eventPayloads: prune_event_payloads(event_payload_grace_seconds, dry_run?)
    }
  end

  defp prune_project_snapshots(runtime, dry_run?) do
    root = Path.join(runtime.execution_home_dir, "project-snapshots")
    retained = Storage.list_referenced_snapshot_paths(nil) |> MapSet.new(&Path.expand/1)

    candidates =
      root
      |> child_directories()
      |> Enum.flat_map(&child_directories/1)
      |> Enum.reject(&(Path.expand(&1) in retained))
      |> Enum.map(&candidate_summary/1)

    remove_candidates(candidates, dry_run?)

    %{
      "root" => root,
      "candidateCount" => length(candidates),
      "candidateBytes" => sum_candidate_bytes(candidates),
      "removedCount" => removed_count(candidates, dry_run?),
      "removedBytes" => removed_bytes(candidates, dry_run?)
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

    remove_candidates(candidates, dry_run?)

    %{
      "root" => root,
      "ttlSeconds" => ttl_seconds,
      "candidateCount" => length(candidates),
      "candidateBytes" => sum_candidate_bytes(candidates),
      "removedCount" => removed_count(candidates, dry_run?),
      "removedBytes" => removed_bytes(candidates, dry_run?)
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

  defp remove_candidates(candidates, true), do: candidates

  defp remove_candidates(candidates, false) do
    Enum.each(candidates, fn %{"path" => path} ->
      make_writable_for_removal(path)
      File.rm_rf(path)
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

  defp removed_count(_candidates, true), do: 0
  defp removed_count(candidates, false), do: length(candidates)

  defp removed_bytes(_candidates, true), do: 0
  defp removed_bytes(candidates, false), do: sum_candidate_bytes(candidates)

  defp non_negative_integer(value, _default) when is_integer(value) and value >= 0, do: value
  defp non_negative_integer(_value, default), do: default

  defp truthy?(value) when value in [true, "true", "1", 1], do: true
  defp truthy?(_value), do: false
end
