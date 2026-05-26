defmodule VilanoKernel.Router.RuntimeViews do
  @moduledoc false

  alias VilanoKernel.Storage
  alias VilanoKernel.Storage.Usage

  def status_payload do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    runtime_metadata = Storage.runtime_metadata()
    schema_state = Storage.schema_state()

    %{
      ok: true,
      runtimeVersion: runtime_metadata["runtimeVersion"],
      protocolVersion: runtime_metadata["protocolVersion"],
      schemaVersion: runtime_metadata["schemaVersion"],
      appliedMigrations: schema_state["appliedMigrations"],
      port: runtime.port,
      startedAt: runtime.started_at,
      homeDir: runtime.home_dir,
      executionHomeDir: runtime.execution_home_dir,
      projectRoot: runtime.project_root,
      runtimeDbPath: runtime.runtime_db_path,
      managedWorkerCount: runtime.managed_worker_count,
      managedWorkerRuntime: runtime.managed_worker_runtime,
      leaseDurationSeconds: runtime.lease_duration_seconds,
      projectCount: Storage.project_count()
    }
  end

  def runtime_debug_payload do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    active_leases = Storage.list_active_leases()

    busy_retries =
      get_in(Storage.runtime_diagnostics(), [:busyRetries]) ||
        %{profiles: %{}, recentExhausted: []}

    %{
      ok: true,
      busyRetries: busy_retries,
      activeLeases: active_leases,
      managedWorkers: managed_worker_snapshot(runtime.managed_worker_count, active_leases),
      activeTimedSteps: Storage.list_active_timed_steps(),
      leaseQueue: %{
        workflowHead: Storage.oldest_runnable_workflow_candidate(),
        serviceTurnHead: Storage.oldest_runnable_service_turn_candidate(),
        oldestPendingRuns: Storage.list_oldest_pending_runs(),
        pendingByProject: Storage.count_pending_runs_by_project()
      },
      runStatusCounts: Storage.count_runs_by_status(),
      projectRunStatusCounts: Storage.count_runs_by_project_and_status()
    }
  end

  def runtime_storage_payload do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)

    %{
      ok: true,
      roots: %{
        homeDir: runtime.home_dir,
        executionHomeDir: runtime.execution_home_dir,
        artifactHomeDir: runtime.artifact_home_dir,
        runtimeDbPath: runtime.runtime_db_path
      },
      paths:
        Usage.path_summary([
          {"runtime_db", runtime.runtime_db_path, "file"},
          {"daemon_startup_log", Path.join(runtime.home_dir, "kernel-startup.log"), "file"},
          {"runtime_cache", Path.join(runtime.home_dir, "runtime-cache"), "directory"},
          {"artifacts", runtime.artifact_home_dir, "directory"},
          {"event_payloads", Path.join(runtime.execution_home_dir, "event-payloads"),
           "directory"},
          {"project_snapshots", Path.join(runtime.execution_home_dir, "project-snapshots"),
           "directory"},
          {"worker_run_workspaces",
           Path.join([runtime.execution_home_dir, "worker-home", "run-workspaces"]), "directory"}
        ]),
      database: Usage.database_summary()
    }
  end

  def project_snapshots_payload(project_name) do
    %{
      ok: true,
      project: project_name,
      snapshotPaths: Storage.list_referenced_snapshot_paths(project_name)
    }
  end

  defp managed_worker_snapshot(count, active_leases) when is_integer(count) and count > 0 do
    leases_by_worker = Enum.group_by(active_leases, &(&1["leaseWorkerId"] || "unknown"))

    Enum.map(1..count, fn index ->
      worker_id_prefix = "managed-local-#{index}-"

      current_leases =
        active_leases
        |> Enum.filter(fn lease ->
          lease["leaseWorkerId"] == "managed-local-#{index}" or
            String.starts_with?(lease["leaseWorkerId"] || "", worker_id_prefix)
        end)

      %{
        "workerId" => "managed-local-#{index}",
        "activeLeaseCount" => length(current_leases),
        "leases" => summarize_leases(current_leases)
      }
    end) ++
      Enum.reduce(leases_by_worker, [], fn {worker_id, leases}, acc ->
        if is_binary(worker_id) and String.starts_with?(worker_id, "managed-local-") do
          acc
        else
          [
            %{
              "workerId" => worker_id,
              "activeLeaseCount" => length(leases),
              "leases" => summarize_leases(leases)
            }
            | acc
          ]
        end
      end)
  end

  defp managed_worker_snapshot(_count, active_leases) do
    active_leases
    |> Enum.group_by(&(&1["leaseWorkerId"] || "unknown"))
    |> Enum.map(fn {worker_id, leases} ->
      %{
        "workerId" => worker_id,
        "activeLeaseCount" => length(leases),
        "leases" => summarize_leases(leases)
      }
    end)
  end

  defp summarize_leases(leases) do
    Enum.map(leases, fn lease ->
      %{
        "leaseId" => lease["leaseId"],
        "runId" => lease["runId"],
        "definitionName" => lease["definitionName"],
        "status" => lease["status"],
        "leaseExpiresAt" => lease["leaseExpiresAt"]
      }
    end)
  end
end
