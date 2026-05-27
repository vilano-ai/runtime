defmodule VilanoKernel.Storage.Prune do
  @moduledoc false

  import Bitwise

  alias Ecto.Adapters.SQL
  alias VilanoKernel.ManagedWorker
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage
  alias VilanoKernel.Storage.{EventPayloads, Infrastructure, Usage}

  @default_run_workspace_ttl_seconds 86_400
  @default_artifact_grace_seconds 300
  @default_event_payload_grace_seconds 300
  @default_project_snapshot_grace_seconds 300
  @pending_project_snapshot_min_grace_seconds 300
  @run_prune_batch_size 75

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
         {:ok, completed_run_ttl_seconds} <-
           optional_non_negative_integer(
             opts,
             "completedRunTtlSeconds",
             :completed_run_ttl_seconds
           ),
         {:ok, service_envelope_ttl_seconds} <-
           optional_non_negative_integer(
             opts,
             "serviceEnvelopeTtlSeconds",
             :service_envelope_ttl_seconds
           ),
         {:ok, artifact_grace_seconds} <-
           non_negative_integer(
             opts,
             "artifactGraceSeconds",
             :artifact_grace_seconds,
             @default_artifact_grace_seconds
           ),
         {:ok, event_payload_grace_seconds} <-
           non_negative_integer(
             opts,
             "eventPayloadGraceSeconds",
             :event_payload_grace_seconds,
             @default_event_payload_grace_seconds
           ),
         {:ok, runtime_cache_ttl_seconds} <-
           optional_non_negative_integer(
             opts,
             "runtimeCacheTtlSeconds",
             :runtime_cache_ttl_seconds
           ),
         {:ok, daemon_log_max_bytes} <-
           optional_non_negative_integer(
             opts,
             "daemonLogMaxBytes",
             :daemon_log_max_bytes
           ),
         {:ok, vacuum_database?} <-
           boolean_option(opts, "vacuumDatabase", :vacuum_database, false) do
      prune_result = %{
        ok: true,
        dryRun: dry_run?,
        prunedAt: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601(),
        projectSnapshots:
          prune_project_snapshots(runtime, project_snapshot_grace_seconds, dry_run?),
        runWorkspaces: prune_run_workspaces(runtime, run_workspace_ttl_seconds, dry_run?),
        completedRuns: prune_completed_runs(completed_run_ttl_seconds, dry_run?),
        serviceEnvelopes: prune_service_envelopes(service_envelope_ttl_seconds, dry_run?),
        artifacts: prune_artifacts(runtime, artifact_grace_seconds, dry_run?),
        eventPayloads: prune_event_payloads(event_payload_grace_seconds, dry_run?),
        runtimeCache: prune_runtime_cache(runtime, runtime_cache_ttl_seconds, dry_run?),
        daemonLog: prune_daemon_log(runtime, daemon_log_max_bytes, dry_run?)
      }

      Map.put(
        prune_result,
        :database,
        maintain_database(runtime, vacuum_database?, dry_run?)
      )
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
      |> Enum.reject(
        &retained_or_active_project_snapshot?(&1, retained, now_seconds, grace_seconds)
      )
      |> Enum.filter(&older_than?(&1, now_seconds, grace_seconds))
      |> Enum.map(&candidate_summary/1)

    removals = remove_project_snapshot_candidates(candidates, retained, grace_seconds, dry_run?)

    unless dry_run? do
      prune_stale_project_snapshot_pending_markers(root, grace_seconds)
    end

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
      |> Enum.reject(&active_workspace_path?(&1, active_lease_ids))
      |> Enum.filter(&older_than?(&1, now_seconds, ttl_seconds))
      |> Enum.map(&candidate_summary/1)

    removals = remove_run_workspace_candidates(candidates, ttl_seconds, dry_run?)

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

  defp prune_completed_runs(nil, _dry_run?) do
    %{
      "enabled" => false,
      "ttlSeconds" => nil,
      "candidateCount" => 0,
      "removedCount" => 0
    }
  end

  defp prune_completed_runs(ttl_seconds, dry_run?) do
    cutoff =
      DateTime.utc_now()
      |> DateTime.add(-ttl_seconds, :second)
      |> DateTime.truncate(:second)
      |> DateTime.to_iso8601()

    eligible_run_ids = terminal_workflow_run_ids_before(cutoff)
    run_components = relationship_safe_run_components(eligible_run_ids)
    run_ids = List.flatten(run_components)

    removed_count =
      if dry_run? do
        0
      else
        delete_runtime_rows_for_run_components!(run_components)
      end

    %{
      "enabled" => true,
      "ttlSeconds" => ttl_seconds,
      "cutoff" => cutoff,
      "eligibleCount" => length(eligible_run_ids),
      "candidateCount" => length(run_ids),
      "skippedUnsafeCount" => length(eligible_run_ids) - length(run_ids),
      "removedCount" => removed_count
    }
  end

  defp prune_service_envelopes(nil, _dry_run?) do
    %{
      "enabled" => false,
      "ttlSeconds" => nil,
      "candidateCount" => 0,
      "removedCount" => 0
    }
  end

  defp prune_service_envelopes(ttl_seconds, dry_run?) do
    cutoff =
      DateTime.utc_now()
      |> DateTime.add(-ttl_seconds, :second)
      |> DateTime.truncate(:second)
      |> DateTime.to_iso8601()

    candidate_count = terminal_service_envelope_count_before(cutoff)

    removed_count =
      if dry_run? do
        0
      else
        delete_terminal_service_envelopes_before!(cutoff)
        max(candidate_count - terminal_service_envelope_count_before(cutoff), 0)
      end

    %{
      "enabled" => true,
      "ttlSeconds" => ttl_seconds,
      "cutoff" => cutoff,
      "candidateCount" => candidate_count,
      "removedCount" => removed_count
    }
  end

  defp prune_artifacts(runtime, grace_seconds, dry_run?) do
    root = Path.expand(runtime.artifact_home_dir)
    now_seconds = System.system_time(:second)
    paths = descendant_files(root)
    retained = referenced_artifact_paths(runtime)
    active_run_ids = active_artifact_run_ids()

    candidates =
      paths
      |> Enum.reject(&retained_or_active_run_artifact?(root, &1, retained, active_run_ids))
      |> Enum.filter(&older_than?(&1, now_seconds, grace_seconds))
      |> Enum.map(&candidate_summary/1)

    removals = remove_artifact_candidates(candidates, root, retained, active_run_ids, dry_run?)

    unless dry_run? do
      empty_dir_grace_seconds = max(grace_seconds, 60)

      prune_empty_artifact_directories(
        root,
        active_artifact_run_ids(),
        System.system_time(:second),
        empty_dir_grace_seconds
      )
    end

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

  defp prune_runtime_cache(runtime, nil, _dry_run?) do
    %{
      "enabled" => false,
      "root" => runtime_cache_root(runtime),
      "ttlSeconds" => nil,
      "candidateCount" => 0,
      "candidateBytes" => 0,
      "removedCount" => 0,
      "removedBytes" => 0,
      "failedCount" => 0,
      "failedBytes" => 0,
      "failedPaths" => []
    }
  end

  defp prune_runtime_cache(runtime, ttl_seconds, dry_run?) do
    root = runtime_cache_root(runtime)
    retained_versions = current_worker_cache_versions(runtime)
    now_seconds = System.system_time(:second)

    candidates =
      root
      |> child_directories()
      |> Enum.reject(&(Path.basename(&1) in retained_versions))
      |> Enum.filter(&older_than?(&1, now_seconds, ttl_seconds))
      |> Enum.map(&candidate_summary/1)

    removals = remove_candidates(candidates, dry_run?)

    %{
      "enabled" => true,
      "root" => root,
      "ttlSeconds" => ttl_seconds,
      "retainedVersions" => MapSet.to_list(retained_versions),
      "candidateCount" => length(candidates),
      "candidateBytes" => sum_candidate_bytes(candidates),
      "removedCount" => removed_count(removals),
      "removedBytes" => removed_bytes(removals),
      "failedCount" => failed_count(removals),
      "failedBytes" => failed_bytes(removals),
      "failedPaths" => failed_paths(removals)
    }
  end

  defp prune_daemon_log(runtime, nil, _dry_run?) do
    path = daemon_log_path(runtime)
    bytes = path_bytes(path)

    %{
      "enabled" => false,
      "path" => path,
      "maxBytes" => nil,
      "previousBytes" => bytes,
      "truncated" => false,
      "removedBytes" => 0
    }
  end

  defp prune_daemon_log(runtime, max_bytes, dry_run?) do
    path = daemon_log_path(runtime)
    bytes = path_bytes(path)
    should_truncate? = bytes > max_bytes

    truncate_result =
      cond do
        not should_truncate? or dry_run? -> :skipped
        true -> File.write(path, "", [:write])
      end

    truncated? = truncate_result == :ok

    %{
      "enabled" => true,
      "path" => path,
      "maxBytes" => max_bytes,
      "previousBytes" => bytes,
      "truncated" => truncated?,
      "removedBytes" => if(truncated?, do: bytes, else: 0),
      "failureReason" => daemon_log_truncate_failure_reason(truncate_result)
    }
  end

  defp maintain_database(runtime, vacuum_database?, dry_run?) do
    before_bytes = database_files_bytes(runtime.runtime_db_path)

    checkpoint =
      if dry_run? do
        %{
          "attempted" => false,
          "checkpointed" => false,
          "busy" => nil,
          "logFrames" => nil,
          "checkpointedFrames" => nil
        }
      else
        checkpoint_database!()
      end

    vacuumed? =
      if dry_run? or not vacuum_database? do
        false
      else
        vacuum_database!()
        true
      end

    %{
      "runtimeDbPath" => runtime.runtime_db_path,
      "beforeBytes" => before_bytes,
      "afterBytes" => database_files_bytes(runtime.runtime_db_path),
      "walCheckpointed" => checkpoint["checkpointed"],
      "walCheckpoint" => checkpoint,
      "vacuumed" => vacuumed?
    }
  end

  defp runtime_cache_root(runtime),
    do: Path.join([runtime.home_dir, "runtime-cache", "managed-workers"])

  defp current_worker_cache_versions(runtime) do
    case ManagedWorker.Launcher.worker_cache_version(runtime) do
      version when is_binary(version) and version != "" -> MapSet.new([version])
      _ -> MapSet.new()
    end
  rescue
    _error -> MapSet.new()
  end

  defp daemon_log_path(runtime), do: Path.join(runtime.home_dir, "kernel-startup.log")

  defp database_files_bytes(runtime_db_path) do
    [runtime_db_path, runtime_db_path <> "-wal", runtime_db_path <> "-shm"]
    |> Enum.map(&path_bytes/1)
    |> Enum.sum()
  end

  defp path_bytes(path), do: Usage.path_usage(path)["bytes"] || 0

  defp checkpoint_database! do
    Infrastructure.run_with_busy_retry(
      fn ->
        Repo
        |> SQL.query!("pragma wal_checkpoint(truncate)", [])
        |> wal_checkpoint_result()
      end,
      :admin_control
    )
  end

  defp wal_checkpoint_result(%{columns: columns, rows: [row | _rows]}) do
    values = Enum.zip(columns, row) |> Map.new()
    busy = integer_or_nil(values["busy"])

    %{
      "attempted" => true,
      "checkpointed" => busy == 0,
      "busy" => busy,
      "logFrames" => integer_or_nil(values["log"]),
      "checkpointedFrames" => integer_or_nil(values["checkpointed"])
    }
  end

  defp wal_checkpoint_result(_result) do
    %{
      "attempted" => true,
      "checkpointed" => false,
      "busy" => nil,
      "logFrames" => nil,
      "checkpointedFrames" => nil
    }
  end

  defp vacuum_database! do
    Infrastructure.run_with_busy_retry(
      fn ->
        SQL.query!(Repo, "vacuum", [])
      end,
      :admin_control
    )
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

  defp descendant_files(root) do
    case File.ls(root) do
      {:ok, entries} ->
        Enum.flat_map(entries, fn entry ->
          path = Path.join(root, entry)

          case File.lstat(path) do
            {:ok, %{type: :directory}} -> descendant_files(path)
            {:ok, %{type: type}} when type in [:regular, :symlink] -> [path]
            _ -> []
          end
        end)

      {:error, :enoent} ->
        []

      {:error, _reason} ->
        []
    end
  end

  defp prune_empty_artifact_directories(
         root,
         active_run_ids,
         now_seconds,
         grace_seconds
       ) do
    root
    |> child_directories()
    |> Enum.each(
      &prune_empty_artifact_directory(
        root,
        &1,
        active_run_ids,
        now_seconds,
        grace_seconds
      )
    )
  end

  defp prune_empty_artifact_directory(
         root,
         path,
         active_run_ids,
         now_seconds,
         grace_seconds
       ) do
    path
    |> child_directories()
    |> Enum.each(
      &prune_empty_artifact_directory(
        root,
        &1,
        active_run_ids,
        now_seconds,
        grace_seconds
      )
    )

    relative_path = Path.relative_to(Path.expand(path), root)

    if older_than?(path, now_seconds, grace_seconds) and
         not active_artifact_path?(relative_path, active_run_ids) do
      case File.rmdir(path) do
        :ok -> :ok
        {:error, _reason} -> :ok
      end
    end
  end

  defp remove_run_workspace_candidates(candidates, _ttl_seconds, true) do
    Enum.map(candidates, &Map.put(&1, "removalStatus", "dry_run"))
  end

  defp remove_run_workspace_candidates(candidates, ttl_seconds, false) do
    active_lease_ids = Storage.list_active_leases() |> MapSet.new(& &1["leaseId"])
    now_seconds = System.system_time(:second)

    Enum.map(candidates, fn %{"path" => path} = candidate ->
      cond do
        active_workspace_path?(path, active_lease_ids) ->
          Map.merge(candidate, %{"removalStatus" => "retained"})

        not older_than?(path, now_seconds, ttl_seconds) ->
          Map.merge(candidate, %{"removalStatus" => "retained"})

        true ->
          remove_candidate_path(candidate)
      end
    end)
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
        now_seconds - mtime_seconds > ttl_seconds

      _ ->
        false
    end
  end

  defp active_workspace_path?(path, active_lease_ids) do
    basename = Path.basename(path)

    Enum.any?(active_lease_ids, fn lease_id ->
      basename == lease_id or String.starts_with?(basename, "#{lease_id}.tmp-")
    end)
  end

  defp retained_or_active_project_snapshot?(path, retained, now_seconds, grace_seconds) do
    expanded_path = Path.expand(path)

    MapSet.member?(retained, expanded_path) or
      active_project_snapshot_pending_marker?(path, now_seconds, grace_seconds)
  end

  defp project_snapshot_pending_marker_path(path) do
    basename =
      path
      |> Path.basename()
      |> project_snapshot_pending_basename()

    Path.join([Path.dirname(path), ".pending", "#{basename}.pending"])
  end

  defp project_snapshot_pending_basename(basename) do
    basename
    |> String.split(".tmp-", parts: 2)
    |> List.first()
  end

  defp active_project_snapshot_pending_marker?(path, now_seconds, grace_seconds) do
    marker_path = project_snapshot_pending_marker_path(path)
    marker_grace_seconds = max(grace_seconds, @pending_project_snapshot_min_grace_seconds)

    File.exists?(marker_path) and not older_than?(marker_path, now_seconds, marker_grace_seconds)
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
    Enum.map(candidates, &remove_candidate_path/1)
  end

  defp remove_project_snapshot_candidates(candidates, _retained, _grace_seconds, true) do
    Enum.map(candidates, &Map.put(&1, "removalStatus", "dry_run"))
  end

  defp remove_project_snapshot_candidates(candidates, retained, grace_seconds, false) do
    latest_retained =
      Storage.list_referenced_snapshot_paths(nil)
      |> MapSet.new(&Path.expand/1)
      |> MapSet.union(retained)

    now_seconds = System.system_time(:second)

    Enum.map(candidates, fn %{"path" => path} = candidate ->
      if retained_or_active_project_snapshot?(path, latest_retained, now_seconds, grace_seconds) do
        Map.merge(candidate, %{"removalStatus" => "retained"})
      else
        removal = remove_candidate_path(candidate)

        if removal["removalStatus"] in ["removed", "missing"] do
          remove_file(project_snapshot_pending_marker_path(path))
        end

        removal
      end
    end)
  end

  defp remove_artifact_candidates(candidates, _root, _retained, _active_run_ids, true) do
    Enum.map(candidates, &Map.put(&1, "removalStatus", "dry_run"))
  end

  defp remove_artifact_candidates([], _root, _retained, _active_run_ids, false), do: []

  defp remove_artifact_candidates(candidates, root, retained, active_run_ids, false) do
    latest_retained = MapSet.union(retained, referenced_artifact_paths_for_root(root))
    latest_active_run_ids = MapSet.union(active_run_ids, active_artifact_run_ids())

    Enum.map(candidates, fn %{"path" => path} = candidate ->
      case artifact_removal_allowed?(root, path, latest_retained, latest_active_run_ids) do
        {:ok, false} -> Map.merge(candidate, %{"removalStatus" => "retained"})
        {:ok, true} -> remove_candidate_path(candidate)
      end
    end)
  end

  defp artifact_removal_allowed?(root, path, retained, active_run_ids) do
    relative_path = artifact_relative_path(root, path)

    cond do
      is_nil(relative_path) ->
        {:ok, false}

      MapSet.member?(retained, relative_path) ->
        {:ok, false}

      active_artifact_path?(relative_path, active_run_ids) ->
        {:ok, false}

      true ->
        {:ok, true}
    end
  end

  defp remove_candidate_path(%{"path" => path} = candidate) do
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
  end

  defp prune_stale_project_snapshot_pending_markers(root, grace_seconds) do
    now_seconds = System.system_time(:second)
    marker_grace_seconds = max(grace_seconds, @pending_project_snapshot_min_grace_seconds)

    root
    |> Path.join("*")
    |> Path.join(".pending")
    |> Path.join("*.pending")
    |> Path.wildcard()
    |> Enum.each(fn marker_path ->
      if older_than?(marker_path, now_seconds, marker_grace_seconds) do
        remove_file(marker_path)
        File.rmdir(Path.dirname(marker_path))
      end
    end)
  end

  defp remove_file(path) do
    case File.rm(path) do
      :ok -> :ok
      {:error, :enoent} -> :ok
      {:error, _reason} -> :ok
    end
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

  defp referenced_artifact_paths(runtime) do
    root = Path.expand(runtime.artifact_home_dir)
    referenced_artifact_paths_for_root(root)
  end

  defp referenced_artifact_paths_for_root(root) do
    Infrastructure.run_with_busy_retry(
      fn ->
        referenced_artifact_refs()
        |> Enum.map(&artifact_relative_path_from_ref(root, &1))
        |> Enum.reject(&is_nil/1)
        |> MapSet.new()
      end,
      :public_read
    )
  end

  defp referenced_artifact_refs do
    artifact_refs_from_run_execs() ++ artifact_refs_from_process_events()
  end

  defp artifact_refs_from_run_execs do
    Repo
    |> SQL.query!(
      """
      select stdout_ref, stderr_ref, artifacts_json
      from run_execs
      """,
      []
    )
    |> rows_to_maps()
    |> Enum.flat_map(&artifact_refs_from_exec_row/1)
  end

  defp artifact_refs_from_exec_row(row) do
    [row["stdout_ref"], row["stderr_ref"]]
    |> Kernel.++(artifact_refs_from_artifacts(row["artifacts_json"]))
    |> Enum.filter(&(is_binary(&1) and &1 != ""))
  end

  defp artifact_refs_from_process_events do
    Repo
    |> SQL.query!(
      """
      select body_json
      from run_events
      where event_type in ('ProcessCompleted', 'ProcessFailed', 'ProcessCancelled')
      """,
      []
    )
    |> rows_to_maps()
    |> Enum.flat_map(&artifact_refs_from_event_row/1)
  end

  defp artifact_refs_from_event_row(%{"body_json" => body_json}) do
    case Jason.decode(body_json) do
      {:ok, body} ->
        body
        |> EventPayloads.hydrate_body()
        |> artifact_refs_from_event_body()

      {:error, _reason} ->
        []
    end
  end

  defp artifact_refs_from_event_body(%{} = body) do
    [body["stdoutRef"], body["stderrRef"]]
    |> Kernel.++(artifact_refs_from_artifacts(body["artifacts"]))
    |> Enum.filter(&(is_binary(&1) and &1 != ""))
  end

  defp artifact_refs_from_event_body(_body), do: []

  defp artifact_refs_from_artifacts(nil), do: []

  defp artifact_refs_from_artifacts(value) when is_list(value) do
    value
    |> Enum.map(fn
      %{"ref" => ref} -> ref
      _ -> nil
    end)
    |> Enum.filter(&is_binary/1)
  end

  defp artifact_refs_from_artifacts(value) when is_binary(value) do
    case Jason.decode(value) do
      {:ok, artifacts} when is_list(artifacts) ->
        artifact_refs_from_artifacts(artifacts)

      _ ->
        []
    end
  end

  defp artifact_relative_path(root, path) do
    root
    |> artifact_relative_path_from_ref(Path.relative_to(path, root))
  end

  defp retained_or_active_run_artifact?(root, path, retained, active_run_ids) do
    relative_path = artifact_relative_path(root, path)

    MapSet.member?(retained, relative_path) or
      active_artifact_path?(relative_path, active_run_ids)
  end

  defp active_artifact_path?(nil, _active_run_ids), do: false

  defp active_artifact_path?(relative_path, active_run_ids) do
    relative_path
    |> artifact_run_id_from_relative_path()
    |> case do
      nil -> false
      run_id -> MapSet.member?(active_run_ids, run_id)
    end
  end

  defp artifact_run_id_from_relative_path(nil), do: nil

  defp artifact_run_id_from_relative_path(relative_path) do
    case Path.split(relative_path) do
      ["runs", run_id | _rest] -> run_id
      ["artifacts", "runs", run_id | _rest] -> run_id
      _parts -> nil
    end
  end

  defp artifact_relative_path_from_ref(_root, nil), do: nil
  defp artifact_relative_path_from_ref(_root, ""), do: nil

  defp artifact_relative_path_from_ref(root, ref) when is_binary(ref) do
    if Path.type(ref) == :absolute do
      nil
    else
      path = Path.expand(Path.join(root, ref))

      if inside_root?(root, path) and path != root do
        Path.relative_to(path, root)
      else
        nil
      end
    end
  end

  defp inside_root?(root, path) do
    path == root or String.starts_with?(path, root <> "/")
  end

  defp terminal_workflow_run_ids_before(cutoff) do
    Infrastructure.run_with_busy_retry(
      fn ->
        Repo
        |> SQL.query!(
          """
          select id
          from runs
          where
            definition_kind = 'workflow'
            and status in ('completed', 'failed', 'cancelled')
            and lease_id is null
            and updated_at <= ?
          order by updated_at asc
          """,
          [cutoff]
        )
        |> rows_to_maps()
        |> Enum.map(& &1["id"])
      end,
      :public_read
    )
  end

  defp terminal_service_envelope_count_before(cutoff) do
    Infrastructure.run_with_busy_retry(
      fn ->
        Repo
        |> SQL.query!(
          """
          select count(*)
          from service_envelopes
          where status in ('completed', 'failed') and updated_at <= ?
          """,
          [cutoff]
        )
        |> first_integer()
      end,
      :public_read
    )
  end

  defp active_artifact_run_ids do
    Infrastructure.run_with_busy_retry(
      fn ->
        Repo
        |> SQL.query!(
          """
          select id
          from runs indexed by runs_lease_status_idx
          where lease_id is not null

          union

          select id
          from runs indexed by runs_status_lease_idx
          where status in ('pending', 'running', 'waiting', 'active', 'idle')
          """,
          []
        )
        |> rows_to_maps()
        |> Enum.map(& &1["id"])
        |> MapSet.new()
      end,
      :public_read
    )
  end

  defp delete_terminal_service_envelopes_before!(cutoff) do
    case Infrastructure.transaction_with_busy_retry(
           fn ->
             SQL.query!(
               Repo,
               """
               delete from service_envelopes
               where status in ('completed', 'failed') and updated_at <= ?
               """,
               [cutoff]
             )

             :ok
           end,
           :admin_control
         ) do
      {:ok, :ok} -> :ok
      {:error, reason} -> raise(reason)
    end
  end

  defp relationship_safe_run_components([]), do: []

  defp relationship_safe_run_components(run_ids) do
    eligible = MapSet.new(run_ids)
    edges = relationship_edges_for_run_ids(run_ids)

    adjacency =
      Enum.reduce(edges, %{}, fn {left_id, right_id}, acc ->
        if MapSet.member?(eligible, left_id) and MapSet.member?(eligible, right_id) do
          acc
          |> Map.update(left_id, MapSet.new([right_id]), &MapSet.put(&1, right_id))
          |> Map.update(right_id, MapSet.new([left_id]), &MapSet.put(&1, left_id))
        else
          acc
        end
      end)

    boundary =
      Enum.reduce(edges, MapSet.new(), fn {left_id, right_id}, acc ->
        left_eligible? = MapSet.member?(eligible, left_id)
        right_eligible? = MapSet.member?(eligible, right_id)

        cond do
          left_eligible? and right_eligible? -> acc
          left_eligible? -> MapSet.put(acc, left_id)
          right_eligible? -> MapSet.put(acc, right_id)
          true -> acc
        end
      end)

    unsafe = expand_unsafe_runs(boundary, adjacency)

    safe_components_for_run_ids(run_ids, unsafe, adjacency)
  end

  defp safe_components_for_run_ids(run_ids, unsafe, adjacency) do
    {_seen, components} =
      Enum.reduce(run_ids, {MapSet.new(), []}, fn run_id, {seen, components} ->
        cond do
          MapSet.member?(unsafe, run_id) ->
            {seen, components}

          MapSet.member?(seen, run_id) ->
            {seen, components}

          true ->
            component = collect_safe_component([run_id], MapSet.new(), unsafe, adjacency)
            {MapSet.union(seen, MapSet.new(component)), [component | components]}
        end
      end)

    Enum.reverse(components)
  end

  defp collect_safe_component([], component, _unsafe, _adjacency), do: MapSet.to_list(component)

  defp collect_safe_component([run_id | rest], component, unsafe, adjacency) do
    cond do
      MapSet.member?(unsafe, run_id) ->
        collect_safe_component(rest, component, unsafe, adjacency)

      MapSet.member?(component, run_id) ->
        collect_safe_component(rest, component, unsafe, adjacency)

      true ->
        next =
          adjacency
          |> Map.get(run_id, MapSet.new())
          |> Enum.reject(&MapSet.member?(component, &1))

        collect_safe_component(next ++ rest, MapSet.put(component, run_id), unsafe, adjacency)
    end
  end

  defp relationship_edges_for_run_ids(run_ids) do
    run_ids
    |> Enum.chunk_every(@run_prune_batch_size)
    |> Enum.flat_map(&relationship_edges_for_run_id_batch/1)
    |> MapSet.new()
    |> MapSet.to_list()
  end

  defp relationship_edges_for_run_id_batch(run_ids) do
    placeholders = placeholders(run_ids)

    Infrastructure.run_with_busy_retry(
      fn ->
        Repo
        |> SQL.query!(
          """
          select parent_run_id as left_id, child_run_id as right_id
          from run_children
          where parent_run_id in (#{placeholders}) or child_run_id in (#{placeholders})

          union all

          select owner_run_id as left_id, target_run_id as right_id
          from run_relationships
          where owner_run_id in (#{placeholders}) or target_run_id in (#{placeholders})

          union all

          select g.owner_run_id as left_id, m.current_child_run_id as right_id
          from run_supervision_groups g
          join run_supervision_members m on m.group_id = g.id
          where
            m.current_child_run_id is not null
            and g.owner_run_id in (#{placeholders})

          union all

          select g.owner_run_id as left_id, m.current_child_run_id as right_id
          from run_supervision_members m
          join run_supervision_groups g on g.id = m.group_id
          where m.current_child_run_id in (#{placeholders})

          union all

          select g.owner_run_id as left_id, r.child_run_id as right_id
          from run_supervision_groups g
          join run_supervision_restarts r on r.group_id = g.id
          where g.owner_run_id in (#{placeholders})

          union all

          select g.owner_run_id as left_id, r.child_run_id as right_id
          from run_supervision_restarts r
          join run_supervision_groups g on g.id = r.group_id
          where r.child_run_id in (#{placeholders})

          union all

          select caller_run_id as left_id, service_run_id as right_id
          from run_service_refs
          where caller_run_id in (#{placeholders}) or service_run_id in (#{placeholders})

          union all

          select sender_run_id as left_id, service_run_id as right_id
          from service_envelopes
          where sender_run_id in (#{placeholders}) or service_run_id in (#{placeholders})
          """,
          repeated_args(run_ids, 12)
        )
        |> rows_to_maps()
        |> Enum.map(fn row -> {row["left_id"], row["right_id"]} end)
        |> Enum.filter(fn {left_id, right_id} -> is_binary(left_id) and is_binary(right_id) end)
      end,
      :public_read
    )
  end

  defp expand_unsafe_runs(boundary, adjacency) do
    do_expand_unsafe_runs(MapSet.to_list(boundary), boundary, adjacency)
  end

  defp do_expand_unsafe_runs([], unsafe, _adjacency), do: unsafe

  defp do_expand_unsafe_runs([run_id | rest], unsafe, adjacency) do
    {next, unsafe} =
      adjacency
      |> Map.get(run_id, MapSet.new())
      |> Enum.reduce({rest, unsafe}, fn neighbor_id, {queue, acc} ->
        if MapSet.member?(acc, neighbor_id) do
          {queue, acc}
        else
          {[neighbor_id | queue], MapSet.put(acc, neighbor_id)}
        end
      end)

    do_expand_unsafe_runs(next, unsafe, adjacency)
  end

  defp delete_runtime_rows_for_run_components!(components) do
    Enum.reduce(components, 0, fn component_run_ids, removed_count ->
      delete_runtime_rows_for_run_ids!(component_run_ids)
      removed_count + length(component_run_ids)
    end)
  end

  defp delete_runtime_rows_for_run_ids!([]), do: 0

  defp delete_runtime_rows_for_run_ids!(run_ids) do
    result =
      Infrastructure.transaction_with_busy_retry(fn ->
        run_ids
        |> Enum.chunk_every(@run_prune_batch_size)
        |> Enum.each(&delete_runtime_rows_for_run_id_batch!/1)

        :ok
      end)

    case result do
      {:ok, :ok} -> length(run_ids)
      {:error, reason} -> raise(reason)
    end
  end

  defp delete_runtime_rows_for_run_id_batch!([]), do: :ok

  defp delete_runtime_rows_for_run_id_batch!(run_ids) do
    placeholders = placeholders(run_ids)

    delete_rows!(
      """
      delete from run_exit_events
      where relationship_id in (
        select id
        from run_relationships
        where owner_run_id in (#{placeholders})
      )
      or run_id in (#{placeholders})
      """,
      run_ids ++ run_ids
    )

    delete_rows!("delete from run_signals where run_id in (#{placeholders})", run_ids)

    delete_rows!(
      """
      delete from run_service_refs
      where caller_run_id in (#{placeholders}) or service_run_id in (#{placeholders})
      """,
      run_ids ++ run_ids
    )

    delete_rows!(
      """
      delete from run_service_ops
      where caller_run_id in (#{placeholders})
      """,
      run_ids
    )

    delete_rows!(
      """
      delete from service_envelopes
      where service_run_id in (#{placeholders}) or sender_run_id in (#{placeholders})
      """,
      run_ids ++ run_ids
    )

    delete_rows!(
      """
      delete from run_supervision_restarts
      where
        group_id in (
          select id
          from run_supervision_groups
          where owner_run_id in (#{placeholders})
        )
        or child_run_id in (#{placeholders})
      """,
      run_ids ++ run_ids
    )

    delete_rows!(
      """
      delete from run_supervision_members
      where
        group_id in (
          select id
          from run_supervision_groups
          where owner_run_id in (#{placeholders})
        )
        or current_child_run_id in (#{placeholders})
      """,
      run_ids ++ run_ids
    )

    delete_rows!(
      "delete from run_supervision_groups where owner_run_id in (#{placeholders})",
      run_ids
    )

    delete_rows!(
      """
      delete from run_children
      where parent_run_id in (#{placeholders}) or child_run_id in (#{placeholders})
      """,
      run_ids ++ run_ids
    )

    delete_rows!(
      "delete from run_topic_publishes where caller_run_id in (#{placeholders})",
      run_ids
    )

    delete_rows!("delete from run_waits where run_id in (#{placeholders})", run_ids)
    delete_rows!("delete from run_execs where run_id in (#{placeholders})", run_ids)
    delete_rows!("delete from run_steps where run_id in (#{placeholders})", run_ids)
    delete_rows!("delete from run_event_sequences where run_id in (#{placeholders})", run_ids)
    delete_rows!("delete from run_events where run_id in (#{placeholders})", run_ids)

    delete_rows!(
      """
      delete from run_relationships
      where owner_run_id in (#{placeholders}) or target_run_id in (#{placeholders})
      """,
      run_ids ++ run_ids
    )

    delete_rows!("delete from service_runs where run_id in (#{placeholders})", run_ids)
    delete_rows!("delete from runs where id in (#{placeholders})", run_ids)

    :ok
  end

  defp placeholders(values) do
    values
    |> Enum.map(fn _value -> "?" end)
    |> Enum.join(", ")
  end

  defp repeated_args(values, times) do
    1..times
    |> Enum.flat_map(fn _index -> values end)
  end

  defp delete_rows!(query, args) do
    SQL.query!(Repo, query, args)
    :ok
  end

  defp rows_to_maps(%{columns: columns, rows: rows}) do
    Enum.map(rows, fn row ->
      Enum.zip(columns, row) |> Map.new()
    end)
  end

  defp first_integer(%{rows: [[value | _rest] | _rows]}) when is_integer(value), do: value
  defp first_integer(_result), do: 0

  defp integer_or_nil(value) when is_integer(value), do: value
  defp integer_or_nil(_value), do: nil

  defp daemon_log_truncate_failure_reason(:ok), do: nil
  defp daemon_log_truncate_failure_reason(:skipped), do: nil
  defp daemon_log_truncate_failure_reason({:error, reason}), do: to_string(reason)

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

  defp optional_non_negative_integer(opts, string_key, atom_key) do
    case fetch_option(opts, string_key, atom_key) do
      :missing ->
        {:ok, nil}

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
