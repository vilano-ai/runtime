defmodule VilanoKernel.Router.PublicHandlers do
  @moduledoc false

  alias VilanoKernel.Storage

  import VilanoKernel.Router.Support

  def status(conn) do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    runtime_metadata = Storage.runtime_metadata()
    schema_state = Storage.schema_state()

    send_json(conn, 200, %{
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
    })
  end

  def shutdown(conn) do
    send_json(conn, 200, %{ok: true, shuttingDown: true})

    Task.start(fn ->
      Process.sleep(50)
      System.stop(0)
    end)
  end

  def project_snapshots(conn) do
    project_name =
      conn
      |> Plug.Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    send_json(conn, 200, %{
      ok: true,
      project: project_name,
      snapshotPaths: Storage.list_referenced_snapshot_paths(project_name)
    })
  end

  def list_projects(conn) do
    send_json(conn, 200, %{ok: true, projects: Storage.list_projects()})
  end

  def create_project(conn) do
    case validate_project_payload(conn.body_params) do
      {:ok, project_payload} ->
        case Storage.create_project!(project_payload) do
          nil ->
            send_error(conn, 409, "project_exists", "Project already exists")

          project ->
            send_json(conn, 200, %{ok: true, project: project})
        end

      {:error, message} ->
        send_error(conn, 400, "invalid_project", message)
    end
  end

  def get_project(conn, name) do
    case Storage.get_project(name) do
      nil -> send_error(conn, 404, "not_found", "Unknown project: #{name}")
      project -> send_json(conn, 200, %{ok: true, project: project})
    end
  end

  def sync_project(conn, name) do
    case validate_project_payload(Map.put(conn.body_params, "name", name)) do
      {:ok, project_payload} ->
        project = Storage.upsert_project!(project_payload)
        send_json(conn, 200, %{ok: true, project: project})

      {:error, message} ->
        send_error(conn, 400, "invalid_project", message)
    end
  end

  def delete_project(conn, name) do
    case Storage.remove_project(name) do
      nil -> send_error(conn, 404, "not_found", "Unknown project: #{name}")
      project -> send_json(conn, 200, %{ok: true, project: project})
    end
  end

  def list_workflows(conn) do
    project_name =
      conn
      |> Plug.Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    case list_definitions("workflow", project_name) do
      {:ok, definitions} ->
        send_json(conn, 200, %{ok: true, project: project_name, definitions: definitions})

      {:error, message} ->
        send_error(conn, 404, "not_found", message)
    end
  end

  def list_services(conn) do
    project_name =
      conn
      |> Plug.Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    case list_definitions("service", project_name) do
      {:ok, definitions} ->
        send_json(conn, 200, %{ok: true, project: project_name, definitions: definitions})

      {:error, message} ->
        send_error(conn, 404, "not_found", message)
    end
  end

  def list_service_runs(conn) do
    query_params =
      conn
      |> Plug.Conn.fetch_query_params()
      |> then(& &1.query_params)

    project_name = query_params["project"]
    active_only = query_params["active"] in ["true", "1", "yes"]

    case project_name do
      nil ->
        send_json(conn, 200, %{
          ok: true,
          project: nil,
          activeOnly: active_only,
          runs: Storage.list_service_runs(nil, active_only)
        })

      name ->
        case Storage.get_project(name) do
          nil ->
            send_error(conn, 404, "not_found", "Unknown project: #{name}")

          _project ->
            send_json(conn, 200, %{
              ok: true,
              project: name,
              activeOnly: active_only,
              runs: Storage.list_service_runs(name, active_only)
            })
        end
    end
  end

  def get_workflow_definition(conn, project, name) do
    case Storage.get_definition(project, "workflow", name) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown workflow '#{name}' in project '#{project}'")

      definition ->
        send_json(conn, 200, %{ok: true, project: project, definition: definition})
    end
  end

  def inspect_service_run(conn, project, name, service_key) do
    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <-
           Storage.get_definition(project, "service", name),
         service_run when not is_nil(service_run) <-
           Storage.find_service_run(project, definition["name"], service_key) do
      _ = project_record
      send_run_inspect(conn, service_run["id"])
    else
      nil ->
        send_error(
          conn,
          404,
          "not_found",
          "Unknown service instance '#{name}/#{service_key}' in project '#{project}'"
        )
    end
  end

  def get_service_envelope(conn, id) do
    case Storage.find_service_envelope(id) do
      nil -> send_error(conn, 404, "not_found", "Unknown service envelope: #{id}")
      envelope -> send_json(conn, 200, %{ok: true, envelope: envelope})
    end
  end

  def ensure_service(conn) do
    service = fetch_required_string(conn.body_params, "service")
    service_key = fetch_required_string(conn.body_params, "serviceKey")
    must_exist = Map.get(conn.body_params, "mustExist", false) == true

    requested_lease_id =
      case Map.get(conn.body_params, "leaseId") do
        value when is_binary(value) and value != "" -> value
        _ -> nil
      end

    effective_lease_id =
      case conn.assigns[:auth_scope] do
        :lease -> conn.assigns[:lease_id]
        _ -> requested_lease_id
      end

    if conn.assigns[:auth_scope] == :lease and conn.assigns[:lease_id] != requested_lease_id do
      send_error(
        conn,
        401,
        "unauthorized",
        "Lease token can only resolve services for its active lease"
      )
    else
      with {project_record, definition} when not is_nil(project_record) <-
             resolve_service_definition(conn.body_params, service),
           run <-
             Storage.ensure_service_run!(
               project_record,
               definition,
               service_key,
               Map.get(conn.body_params, "keyInput", %{}),
               effective_lease_id,
               must_exist
             ) do
        send_json(conn, 200, %{ok: true, run: run})
      else
        nil ->
          send_error(
            conn,
            404,
            "not_found",
            if(must_exist,
              do: "Unknown service instance '#{service}/#{service_key}'",
              else: "Unknown service '#{service}'"
            )
          )
      end
    end
  end

  def enqueue_service_send(conn, project, name, service_key) do
    enqueue_public_service_message(
      conn,
      project,
      name,
      service_key,
      "send",
      fetch_required_string(conn.body_params, "message")
    )
  end

  def enqueue_service_ask(conn, project, name, service_key) do
    enqueue_public_service_message(
      conn,
      project,
      name,
      service_key,
      "ask",
      fetch_required_string(conn.body_params, "message")
    )
  end

  def enqueue_service_signal(conn, project, name, service_key) do
    enqueue_public_service_message(
      conn,
      project,
      name,
      service_key,
      "signal",
      fetch_required_string(conn.body_params, "signal")
    )
  end

  def stop_service(conn, project, name, service_key) do
    with result when not is_nil(result) <- Storage.stop_service_run(project, name, service_key) do
      maybe_kill_managed_worker(result)

      send_json(conn, 200, %{
        ok: true,
        run: result["run"],
        stoppedEnvelopeCount: result["stoppedEnvelopeCount"],
        cancelledWaitCount: result["cancelledWaitCount"],
        cancelledChildRunCount: result["cancelledChildRunCount"],
        cancelledServiceAskCount: result["cancelledServiceAskCount"],
        hadInFlightTurn: result["hadInFlightTurn"]
      })
    else
      nil ->
        send_error(
          conn,
          404,
          "not_found",
          "Unknown service instance '#{name}/#{service_key}' in project '#{project}'"
        )
    end
  end

  def create_run(conn) do
    project = fetch_required_string(conn.body_params, "project")
    workflow = fetch_required_string(conn.body_params, "workflow")

    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <-
           Storage.get_definition(project, "workflow", workflow),
         run <-
           Storage.create_workflow_run!(
             project_record,
             definition,
             Map.get(conn.body_params, "input", %{})
           ) do
      send_json(conn, 200, %{ok: true, run: run})
    else
      nil ->
        send_error(
          conn,
          404,
          "not_found",
          "Unknown workflow '#{workflow}' in project '#{project}'"
        )
    end
  end

  def list_runs(conn) do
    project_name =
      conn
      |> Plug.Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    case project_name do
      nil ->
        send_json(conn, 200, %{ok: true, project: nil, runs: Storage.list_runs()})

      name ->
        case Storage.get_project(name) do
          nil ->
            send_error(conn, 404, "not_found", "Unknown project: #{name}")

          _project ->
            send_json(conn, 200, %{ok: true, project: name, runs: Storage.list_runs(name)})
        end
    end
  end

  def inspect_run(conn, id), do: send_run_inspect(conn, id)

  def replay_run(conn, id), do: send_run_replay(conn, id)

  def cancel_run(conn, id) do
    case Storage.cancel_run(id) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown run: #{id}")

      result ->
        maybe_kill_managed_worker(result)

        send_json(conn, 200, %{
          ok: true,
          run: result["run"],
          cancelledWaitCount: result["cancelledWaitCount"],
          cancelledChildRunCount: result["cancelledChildRunCount"],
          cancelledServiceAskCount: result["cancelledServiceAskCount"],
          hadActiveLease: result["hadActiveLease"],
          stoppedEnvelopeCount: Map.get(result, "stoppedEnvelopeCount", 0),
          hadInFlightTurn: Map.get(result, "hadInFlightTurn", false)
        })
    end
  end

  def signal_run(conn, id) do
    name = fetch_required_string(conn.body_params, "name")
    payload = Map.get(conn.body_params, "payload")

    case Storage.send_run_signal(id, name, payload) do
      nil -> send_error(conn, 404, "not_found", "Unknown run: #{id}")
      signal -> send_json(conn, 200, %{ok: true, signal: signal})
    end
  end

  defp enqueue_public_service_message(conn, project, name, service_key, kind, message_name) do
    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <-
           Storage.get_definition(project, "service", name),
         result <-
           Storage.enqueue_service_envelope!(
             project_record,
             definition,
             service_key,
             Map.get(conn.body_params, "keyInput", %{}),
             kind,
             message_name,
             Map.get(conn.body_params, "payload")
           ) do
      _ = project_record

      case result do
        %{"run" => run, "envelope" => envelope} ->
          send_json(conn, 200, %{ok: true, run: run, envelope: envelope})

        {:error, error} ->
          send_service_enqueue_error(conn, error)
      end
    else
      nil ->
        send_error(conn, 404, "not_found", "Unknown service '#{name}' in project '#{project}'")
    end
  end

  defp resolve_service_definition(body_params, service_name) do
    case Map.get(body_params, "leaseId") do
      lease_id when is_binary(lease_id) and lease_id != "" ->
        with run when not is_nil(run) <- Storage.get_active_run_by_lease(lease_id),
             definition when not is_nil(definition) <-
               find_definition_in_run(run, "service", service_name) do
          {
            %{
              "name" => run["project"],
              "path" => run["projectSnapshotPath"],
              "snapshotPath" => run["projectSnapshotPath"],
              "definitions" => run["projectDefinitions"] || %{"workflows" => [], "services" => []}
            },
            definition
          }
        end

      _ ->
        project = fetch_required_string(body_params, "project")

        with project_record when not is_nil(project_record) <- Storage.get_project(project),
             definition when not is_nil(definition) <-
               Storage.get_definition(project, "service", service_name) do
          {project_record, definition}
        end
    end
  end

  defp find_definition_in_run(run, kind, definition_name) do
    bucket =
      case kind do
        "workflow" -> get_in(run, ["projectDefinitions", "workflows"]) || []
        "service" -> get_in(run, ["projectDefinitions", "services"]) || []
      end

    Enum.find(bucket, &(&1["name"] == definition_name))
  end

  defp send_service_enqueue_error(conn, error) do
    case Map.get(error, "reason") do
      "service_overloaded" ->
        send_error(conn, 429, "service_overloaded", Map.fetch!(error, "message"))

      _ ->
        send_error(conn, 409, "service_stopped", Map.fetch!(error, "message"))
    end
  end
end
