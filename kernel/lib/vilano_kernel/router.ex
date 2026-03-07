defmodule VilanoKernel.Router do
  @moduledoc false

  use Plug.ErrorHandler
  use Plug.Router

  alias Plug.Conn
  alias VilanoKernel.Storage
  alias VilanoKernel.WaitManager

  plug :match

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason

  plug :dispatch

  get "/v1/status" do
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
      projectRoot: runtime.project_root,
      runtimeDbPath: runtime.runtime_db_path,
      managedWorkerCount: runtime.managed_worker_count,
      leaseDurationSeconds: runtime.lease_duration_seconds,
      projectCount: Storage.project_count()
    })
  end

  post "/v1/admin/shutdown" do
    send_json(conn, 200, %{ok: true, shuttingDown: true})
    Task.start(fn ->
      Process.sleep(50)
      System.stop(0)
    end)
  end

  get "/v1/projects" do
    send_json(conn, 200, %{
      ok: true,
      projects: Storage.list_projects()
    })
  end

  post "/v1/projects" do
    project = Storage.upsert_project!(project_payload(conn.body_params))
    send_json(conn, 200, %{ok: true, project: project})
  end

  get "/v1/projects/:name" do
    case Storage.get_project(name) do
      nil -> send_error(conn, 404, "not_found", "Unknown project: #{name}")
      project -> send_json(conn, 200, %{ok: true, project: project})
    end
  end

  post "/v1/projects/:name/sync" do
    project =
      conn.body_params
      |> project_payload()
      |> Map.put("name", name)
      |> Storage.upsert_project!()

    send_json(conn, 200, %{ok: true, project: project})
  end

  delete "/v1/projects/:name" do
    case Storage.remove_project(name) do
      nil -> send_error(conn, 404, "not_found", "Unknown project: #{name}")
      project -> send_json(conn, 200, %{ok: true, project: project})
    end
  end

  get "/v1/workflows" do
    project_name =
      conn
      |> Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    case list_definitions("workflow", project_name) do
      {:ok, definitions} ->
        send_json(conn, 200, %{ok: true, project: project_name, definitions: definitions})

      {:error, message} ->
        send_error(conn, 404, "not_found", message)
    end
  end

  get "/v1/services" do
    project_name =
      conn
      |> Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    case list_definitions("service", project_name) do
      {:ok, definitions} ->
        send_json(conn, 200, %{ok: true, project: project_name, definitions: definitions})

      {:error, message} ->
        send_error(conn, 404, "not_found", message)
    end
  end

  get "/v1/service-runs" do
    query_params =
      conn
      |> Conn.fetch_query_params()
      |> then(& &1.query_params)

    project_name = query_params["project"]
    active_only = query_params["active"] in ["true", "1", "yes"]

    case project_name do
      nil ->
        send_json(conn, 200, %{ok: true, project: nil, activeOnly: active_only, runs: Storage.list_service_runs(nil, active_only)})

      name ->
        case Storage.get_project(name) do
          nil ->
            send_error(conn, 404, "not_found", "Unknown project: #{name}")

          _project ->
            send_json(conn, 200, %{ok: true, project: name, activeOnly: active_only, runs: Storage.list_service_runs(name, active_only)})
        end
    end
  end

  get "/v1/workflows/:project/:name" do
    case Storage.get_definition(project, "workflow", name) do
      nil -> send_error(conn, 404, "not_found", "Unknown workflow '#{name}' in project '#{project}'")
      definition -> send_json(conn, 200, %{ok: true, project: project, definition: definition})
    end
  end

  get "/v1/services/:project/:name/runs/:service_key" do
    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <- Storage.get_definition(project, "service", name),
         service_run when not is_nil(service_run) <- Storage.find_service_run(project, definition["name"], service_key) do
      _ = project_record
      send_run_inspect(conn, service_run["id"])
    else
      nil ->
        send_error(conn, 404, "not_found", "Unknown service instance '#{name}/#{service_key}' in project '#{project}'")
    end
  end

  get "/v1/service-envelopes/:id" do
    case Storage.find_service_envelope(id) do
      nil -> send_error(conn, 404, "not_found", "Unknown service envelope: #{id}")
      envelope -> send_json(conn, 200, %{ok: true, envelope: envelope})
    end
  end

  post "/v1/activations/lease" do
    worker_id = fetch_required_string(conn.body_params, "workerId")

    case Storage.lease_next_run(worker_id) do
      nil ->
        send_json(conn, 200, %{ok: true, activation: nil})

      %{activation_kind: "workflow", lease_id: lease_id, lease_expires_at: lease_expires_at, run: run} ->
        project = Storage.get_project(run["project"])
        definition = Storage.get_definition(run["project"], "workflow", run["definitionName"])

        send_json(conn, 200, %{
          ok: true,
          activation: %{
            kind: "workflow",
            leaseId: lease_id,
            leaseExpiresAt: lease_expires_at,
            run: %{
              id: run["id"],
              input: run["input"]
            },
            project: %{
              name: project["name"],
              path: project["path"]
            },
            definition: definition
          }
        })

      %{
        activation_kind: "service_turn",
        lease_id: lease_id,
        lease_expires_at: lease_expires_at,
        run: run,
        service: service,
        envelope: envelope
      } ->
        project = Storage.get_project(run["project"])
        definition = Storage.get_definition(run["project"], "service", run["definitionName"])

        send_json(conn, 200, %{
          ok: true,
          activation: %{
            kind: "service_turn",
            leaseId: lease_id,
            leaseExpiresAt: lease_expires_at,
            run: %{
              id: run["id"]
            },
            project: %{
              name: project["name"],
              path: project["path"]
            },
            definition: definition,
            service: %{
              key: service["serviceKey"],
              keyInput: service["keyInput"],
              state: service["state"]
            },
            envelope: %{
              id: envelope["id"],
              kind: envelope["kind"],
              name: envelope["name"],
              payload: envelope["payload"],
              correlationId: envelope["correlationId"],
              senderRunId: envelope["senderRunId"]
            }
          }
        })
    end
  end

  post "/v1/leases/:lease_id/heartbeat" do
    worker_id = fetch_required_string(conn.body_params, "workerId")

    case Storage.heartbeat_lease(lease_id, worker_id) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      lease -> send_json(conn, 200, %{ok: true, lease: lease})
    end
  end

  get "/v1/leases/:lease_id/status" do
    send_json(conn, 200, %{ok: true, lease: Storage.lease_status(lease_id)})
  end

  post "/v1/leases/:lease_id/complete" do
    case Storage.complete_run_lease(lease_id, Map.get(conn.body_params, "result", %{})) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      run -> send_json(conn, 200, %{ok: true, run: run})
    end
  end

  post "/v1/leases/:lease_id/fail" do
    error_body = Map.get(conn.body_params, "error", %{})

    case Storage.fail_run_lease(lease_id, error_body) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      run -> send_json(conn, 200, %{ok: true, run: run})
    end
  end

  post "/v1/leases/:lease_id/steps/resolve" do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")
    timeout_ms = Map.get(conn.body_params, "timeoutMs")
    retry_policy = %{
      "maxAttempts" => Map.get(conn.body_params, "maxAttempts"),
      "backoffKind" => Map.get(conn.body_params, "backoffKind"),
      "backoffMs" => Map.get(conn.body_params, "backoffMs"),
      "backoffStepMs" => Map.get(conn.body_params, "backoffStepMs"),
      "backoffFactor" => Map.get(conn.body_params, "backoffFactor"),
      "maxBackoffMs" => Map.get(conn.body_params, "maxBackoffMs"),
      "backoffJitterKind" => Map.get(conn.body_params, "backoffJitterKind"),
      "backoffJitterRatio" => Map.get(conn.body_params, "backoffJitterRatio"),
      "retryOn" => Map.get(conn.body_params, "retryOn")
    }

    case Storage.resolve_step(lease_id, name, key, timeout_ms, retry_policy) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      step -> send_json(conn, 200, %{ok: true, step: step})
    end
  end

  post "/v1/leases/:lease_id/steps/complete" do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.complete_step(lease_id, name, key, Map.get(conn.body_params, "output")) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      step -> send_json(conn, 200, %{ok: true, step: step})
    end
  end

  post "/v1/leases/:lease_id/steps/fail" do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.fail_step(lease_id, name, key, Map.get(conn.body_params, "error", %{})) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      %{"status" => "retry_waiting", "wait" => wait} = step ->
        WaitManager.schedule_timed_wait(wait)
        send_json(conn, 200, %{ok: true, step: step})

      step ->
        send_json(conn, 200, %{ok: true, step: step})
    end
  end

  post "/v1/leases/:lease_id/execs/resolve" do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    exec_spec = %{
      "cmd" => fetch_required_string(conn.body_params, "cmd"),
      "args" => Map.get(conn.body_params, "args", []),
      "cwd" => Map.get(conn.body_params, "cwd"),
      "env" => Map.get(conn.body_params, "env"),
      "timeoutMs" => Map.get(conn.body_params, "timeoutMs")
    }

    case Storage.resolve_exec(lease_id, name, key, exec_spec) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      exec -> send_json(conn, 200, %{ok: true, exec: exec})
    end
  end

  post "/v1/leases/:lease_id/execs/complete" do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    body = %{
      "exitCode" => Map.get(conn.body_params, "exitCode"),
      "signalCode" => Map.get(conn.body_params, "signalCode"),
      "stdoutRef" => Map.get(conn.body_params, "stdoutRef"),
      "stderrRef" => Map.get(conn.body_params, "stderrRef"),
      "artifacts" => Map.get(conn.body_params, "artifacts", []),
      "output" => Map.get(conn.body_params, "output")
    }

    case Storage.complete_exec(lease_id, name, key, body) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      exec -> send_json(conn, 200, %{ok: true, exec: exec})
    end
  end

  post "/v1/leases/:lease_id/execs/fail" do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    body = %{
      "exitCode" => Map.get(conn.body_params, "exitCode"),
      "signalCode" => Map.get(conn.body_params, "signalCode"),
      "stdoutRef" => Map.get(conn.body_params, "stdoutRef"),
      "stderrRef" => Map.get(conn.body_params, "stderrRef"),
      "artifacts" => Map.get(conn.body_params, "artifacts", []),
      "error" => Map.get(conn.body_params, "error", %{}),
      "maxAttempts" => Map.get(conn.body_params, "maxAttempts"),
      "backoffKind" => Map.get(conn.body_params, "backoffKind"),
      "backoffMs" => Map.get(conn.body_params, "backoffMs"),
      "backoffStepMs" => Map.get(conn.body_params, "backoffStepMs"),
      "backoffFactor" => Map.get(conn.body_params, "backoffFactor"),
      "maxBackoffMs" => Map.get(conn.body_params, "maxBackoffMs"),
      "backoffJitterKind" => Map.get(conn.body_params, "backoffJitterKind"),
      "backoffJitterRatio" => Map.get(conn.body_params, "backoffJitterRatio"),
      "retryOn" => Map.get(conn.body_params, "retryOn")
    }

    case Storage.fail_exec(lease_id, name, key, body) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      %{"status" => "retry_waiting", "wait" => wait} = exec ->
        WaitManager.schedule_timed_wait(wait)
        send_json(conn, 200, %{ok: true, exec: exec})

      exec ->
        send_json(conn, 200, %{ok: true, exec: exec})
    end
  end

  post "/v1/leases/:lease_id/waits/sleep" do
    key = fetch_required_string(conn.body_params, "key")
    duration_ms = fetch_required_integer(conn.body_params, "durationMs")

    case Storage.resolve_sleep_wait(lease_id, key, duration_ms) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")

      %{"status" => "suspended", "wait" => wait} = body ->
        WaitManager.schedule_timed_wait(wait)
        send_json(conn, 200, %{ok: true, wait: body})

      body ->
        send_json(conn, 200, %{ok: true, wait: body})
    end
  end

  post "/v1/leases/:lease_id/waits/signal" do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_signal_wait(lease_id, name, key) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      wait -> send_json(conn, 200, %{ok: true, wait: wait})
    end
  end

  post "/v1/leases/:lease_id/spawns/resolve" do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")
    child_run_id = fetch_required_string(conn.body_params, "childRunId")

    case Storage.resolve_spawn(lease_id, name, key, child_run_id, Map.get(conn.body_params, "input", %{})) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      spawn -> send_json(conn, 200, %{ok: true, spawn: spawn})
    end
  end

  post "/v1/leases/:lease_id/children/result" do
    child_run_id = fetch_required_string(conn.body_params, "childRunId")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_child_result_wait(lease_id, child_run_id, key) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease or child run: #{lease_id}")
      child -> send_json(conn, 200, %{ok: true, child: child})
    end
  end

  post "/v1/leases/:lease_id/services/send" do
    service_run_id = fetch_required_string(conn.body_params, "serviceRunId")
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_service_send(lease_id, service_run_id, name, key, Map.get(conn.body_params, "payload")) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease or service: #{lease_id}")
      result -> send_json(conn, 200, %{ok: true, result: result})
    end
  end

  post "/v1/leases/:lease_id/services/ask" do
    service_run_id = fetch_required_string(conn.body_params, "serviceRunId")
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_service_ask(lease_id, service_run_id, name, key, Map.get(conn.body_params, "payload")) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease or service: #{lease_id}")
      result -> send_json(conn, 200, %{ok: true, result: result})
    end
  end

  post "/v1/leases/:lease_id/services/signal" do
    service_run_id = fetch_required_string(conn.body_params, "serviceRunId")
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_service_signal(lease_id, service_run_id, name, key, Map.get(conn.body_params, "payload")) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease or service: #{lease_id}")
      result -> send_json(conn, 200, %{ok: true, result: result})
    end
  end

  post "/v1/leases/:lease_id/service-turns/:envelope_id/complete" do
    body = %{
      "state" => Map.get(conn.body_params, "state"),
      "reply" => Map.get(conn.body_params, "reply"),
      "stop" => Map.get(conn.body_params, "stop", false)
    }

    case Storage.complete_service_turn(lease_id, envelope_id, body) do
      nil -> send_error(conn, 404, "not_found", "Unknown active service turn: #{lease_id}")
      run -> send_json(conn, 200, %{ok: true, run: run})
    end
  end

  post "/v1/leases/:lease_id/service-turns/:envelope_id/fail" do
    error_body = Map.get(conn.body_params, "error", %{})
    retry_options = %{
      "maxAttempts" => Map.get(conn.body_params, "maxAttempts"),
      "backoffKind" => Map.get(conn.body_params, "backoffKind"),
      "backoffMs" => Map.get(conn.body_params, "backoffMs"),
      "backoffStepMs" => Map.get(conn.body_params, "backoffStepMs"),
      "backoffFactor" => Map.get(conn.body_params, "backoffFactor"),
      "maxBackoffMs" => Map.get(conn.body_params, "maxBackoffMs"),
      "backoffJitterKind" => Map.get(conn.body_params, "backoffJitterKind"),
      "backoffJitterRatio" => Map.get(conn.body_params, "backoffJitterRatio"),
      "retryOn" => Map.get(conn.body_params, "retryOn")
    }

    case Storage.fail_service_turn(lease_id, envelope_id, error_body, retry_options) do
      nil -> send_error(conn, 404, "not_found", "Unknown active service turn: #{lease_id}")
      %{"status" => "retry_waiting", "run" => run, "wait" => wait} ->
        WaitManager.schedule_timed_wait(wait)
        send_json(conn, 200, %{ok: true, run: run, wait: wait, status: "retry_waiting"})

      run ->
        send_json(conn, 200, %{ok: true, run: run})
    end
  end

  post "/v1/services/ensure" do
    project = fetch_required_string(conn.body_params, "project")
    service = fetch_required_string(conn.body_params, "service")
    service_key = fetch_required_string(conn.body_params, "serviceKey")

    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <- Storage.get_definition(project, "service", service),
         run <- Storage.ensure_service_run!(project, definition["name"], service_key, Map.get(conn.body_params, "keyInput", %{})) do
      _ = project_record
      send_json(conn, 200, %{ok: true, run: run})
    else
      nil ->
        send_error(conn, 404, "not_found", "Unknown service '#{service}' in project '#{project}'")
    end
  end

  post "/v1/services/:project/:name/runs/:service_key/send" do
    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <- Storage.get_definition(project, "service", name),
         result <-
           Storage.enqueue_service_envelope!(
             project,
             definition["name"],
             service_key,
             Map.get(conn.body_params, "keyInput", %{}),
             "send",
             fetch_required_string(conn.body_params, "message"),
             Map.get(conn.body_params, "payload")
           ) do
      _ = project_record

      case result do
        %{"run" => run, "envelope" => envelope} ->
          send_json(conn, 200, %{ok: true, run: run, envelope: envelope})

        {:error, error} ->
          send_error(conn, 409, "service_stopped", Map.fetch!(error, "message"))
      end
    else
      nil ->
        send_error(conn, 404, "not_found", "Unknown service '#{name}' in project '#{project}'")
    end
  end

  post "/v1/services/:project/:name/runs/:service_key/ask" do
    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <- Storage.get_definition(project, "service", name),
         result <-
           Storage.enqueue_service_envelope!(
             project,
             definition["name"],
             service_key,
             Map.get(conn.body_params, "keyInput", %{}),
             "ask",
             fetch_required_string(conn.body_params, "message"),
             Map.get(conn.body_params, "payload")
           ) do
      _ = project_record

      case result do
        %{"run" => run, "envelope" => envelope} ->
          send_json(conn, 200, %{ok: true, run: run, envelope: envelope})

        {:error, error} ->
          send_error(conn, 409, "service_stopped", Map.fetch!(error, "message"))
      end
    else
      nil ->
        send_error(conn, 404, "not_found", "Unknown service '#{name}' in project '#{project}'")
    end
  end

  post "/v1/services/:project/:name/runs/:service_key/signal" do
    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <- Storage.get_definition(project, "service", name),
         result <-
           Storage.enqueue_service_envelope!(
             project,
             definition["name"],
             service_key,
             Map.get(conn.body_params, "keyInput", %{}),
             "signal",
             fetch_required_string(conn.body_params, "signal"),
             Map.get(conn.body_params, "payload")
           ) do
      _ = project_record

      case result do
        %{"run" => run, "envelope" => envelope} ->
          send_json(conn, 200, %{ok: true, run: run, envelope: envelope})

        {:error, error} ->
          send_error(conn, 409, "service_stopped", Map.fetch!(error, "message"))
      end
    else
      nil ->
        send_error(conn, 404, "not_found", "Unknown service '#{name}' in project '#{project}'")
    end
  end

  post "/v1/services/:project/:name/runs/:service_key/stop" do
    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <- Storage.get_definition(project, "service", name),
         result when not is_nil(result) <- Storage.stop_service_run(project, definition["name"], service_key) do
      _ = project_record
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
        send_error(conn, 404, "not_found", "Unknown service instance '#{name}/#{service_key}' in project '#{project}'")
    end
  end

  post "/v1/runs" do
    project = fetch_required_string(conn.body_params, "project")
    workflow = fetch_required_string(conn.body_params, "workflow")

    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <- Storage.get_definition(project, "workflow", workflow),
         run <- Storage.create_workflow_run!(project, definition["name"], Map.get(conn.body_params, "input", %{})) do
      _ = project_record
      send_json(conn, 200, %{ok: true, run: run})
    else
      nil ->
        send_error(conn, 404, "not_found", "Unknown workflow '#{workflow}' in project '#{project}'")
    end
  end

  get "/v1/runs" do
    project_name =
      conn
      |> Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    case project_name do
      nil ->
        send_json(conn, 200, %{ok: true, project: nil, runs: Storage.list_runs()})

      name ->
        case Storage.get_project(name) do
          nil -> send_error(conn, 404, "not_found", "Unknown project: #{name}")
          _project -> send_json(conn, 200, %{ok: true, project: name, runs: Storage.list_runs(name)})
        end
    end
  end

  get "/v1/runs/:id" do
    send_run_inspect(conn, id)
  end

  get "/v1/runs/:id/replay" do
    send_run_replay(conn, id)
  end

  post "/v1/runs/:id/cancel" do
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

  post "/v1/runs/:id/signals" do
    name = fetch_required_string(conn.body_params, "name")
    payload = Map.get(conn.body_params, "payload")

    case Storage.send_run_signal(id, name, payload) do
      nil -> send_error(conn, 404, "not_found", "Unknown run: #{id}")
      signal -> send_json(conn, 200, %{ok: true, signal: signal})
    end
  end

  match _ do
    send_error(conn, 404, "not_found", "Unknown endpoint: #{conn.method} #{conn.request_path}")
  end

  defp project_payload(body_params) do
    %{
      "name" => fetch_required_string(body_params, "name"),
      "path" => fetch_required_string(body_params, "path"),
      "lastSyncedAt" => Map.get(body_params, "lastSyncedAt"),
      "definitionsManifestHash" => Map.get(body_params, "definitionsManifestHash"),
      "definitions" => %{
        "workflows" => get_in(body_params, ["definitions", "workflows"]) || [],
        "services" => get_in(body_params, ["definitions", "services"]) || []
      }
    }
  end

  defp fetch_required_string(body_params, key) do
    case Map.get(body_params, key) do
      value when is_binary(value) and value != "" -> value
      _ -> raise ArgumentError, "expected '#{key}' to be a non-empty string"
    end
  end

  defp fetch_required_integer(body_params, key) do
    case Map.get(body_params, key) do
      value when is_integer(value) -> value
      _ -> raise ArgumentError, "expected '#{key}' to be an integer"
    end
  end

  defp list_definitions(kind, nil), do: {:ok, Storage.list_definitions(kind)}

  defp list_definitions(kind, project_name) do
    case Storage.list_definitions(kind, project_name) do
      nil -> {:error, "Unknown project: #{project_name}"}
      definitions -> {:ok, definitions}
    end
  end

  defp send_run_inspect(conn, run_id) do
    case Storage.get_run_for_inspect(run_id) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown run: #{run_id}")

      run ->
        send_json(conn, 200, build_run_inspect_body(run, run_id))
    end
  end

  defp send_run_replay(conn, run_id) do
    case Storage.get_run_for_inspect(run_id) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown run: #{run_id}")

      run ->
        inspect_body = build_run_inspect_body(run, run_id)

        send_json(conn, 200, Map.put(inspect_body, :timeline, derive_replay_entries(inspect_body.events)))
    end
  end

  defp build_run_inspect_body(run, run_id) do
    %{
      ok: true,
      run: run,
      events: Storage.list_run_events(run_id),
      steps: Storage.list_run_steps(run_id),
      execs: Storage.list_run_execs(run_id),
      waits: Storage.list_run_waits(run_id),
      signals: Storage.list_run_signals(run_id),
      children: Storage.list_run_children(run_id),
      envelopes: Storage.list_service_envelopes(run_id)
    }
  end

  defp derive_replay_entries(events) do
    Enum.map(events, fn event ->
      %{
        seq: Map.fetch!(event, "seq"),
        createdAt: Map.fetch!(event, "createdAt"),
        type: Map.fetch!(event, "type"),
        summary: summarize_replay_event(event),
        body: Map.fetch!(event, "body")
      }
    end)
  end

  defp summarize_replay_event(event) do
    body = body_record(Map.get(event, "body"))

    case Map.get(event, "type") do
      "RunStarted" ->
        format_summary(%{
          input: truncate_json(Map.get(body, "input"))
        })

      "RunLeaseGranted" ->
        format_summary(%{
          lease: Map.get(body, "leaseId"),
          worker: Map.get(body, "workerId"),
          expires: Map.get(body, "leaseExpiresAt")
        })

      "RunCompleted" ->
        format_summary(%{
          result: truncate_json(Map.get(body, "result"))
        })

      "RunFailed" ->
        format_summary(%{
          error: error_message(Map.get(body, "error"))
        })

      type when type in ["RunCancelled", "ServiceStopped"] ->
        format_summary(%{
          reason: Map.get(body, "reason"),
          waits: Map.get(body, "cancelledWaitCount"),
          children: Map.get(body, "cancelledChildRunCount"),
          asks: Map.get(body, "cancelledServiceAskCount")
        })

      "StepStarted" ->
        format_summary(%{
          name: Map.get(body, "name"),
          key: Map.get(body, "key"),
          attempt: Map.get(body, "attempt"),
          timeoutMs: Map.get(body, "timeoutMs"),
          maxAttempts: Map.get(body, "maxAttempts"),
          backoffMs: Map.get(body, "backoffMs")
        })

      "StepCompleted" ->
        format_summary(%{
          name: Map.get(body, "name"),
          key: Map.get(body, "key"),
          output: truncate_json(Map.get(body, "output"))
        })

      type when type in ["StepFailed", "StepCancelled"] ->
        format_summary(%{
          name: Map.get(body, "name"),
          key: Map.get(body, "key"),
          attempt: Map.get(body, "attempt"),
          timedOut: Map.get(body_record(Map.get(body, "error")), "timedOut"),
          family: Map.get(body, "retryFamily"),
          retry: Map.get(body, "retryDecision"),
          retryable: Map.get(body, "retryable"),
          willRetry: Map.get(body, "willRetry"),
          backoffKind: Map.get(body, "backoffKind"),
          backoffMs: Map.get(body, "backoffMs"),
          backoffBaseMs: Map.get(body, "backoffBaseMs"),
          backoffCappedMs: Map.get(body, "backoffCappedMs"),
          backoffJitterKind: Map.get(body, "backoffJitterKind"),
          backoffJitterMs: Map.get(body, "backoffJitterMs"),
          error: error_message(Map.get(body, "error"))
        })

      "ProcessStarted" ->
        format_summary(%{
          name: Map.get(body, "name"),
          key: Map.get(body, "key"),
          attempt: Map.get(body, "attempt"),
          cmd: Map.get(body, "cmd"),
          args:
            case Map.get(body, "args") do
              args when is_list(args) -> truncate_value(Enum.join(args, " "))
              _ -> nil
            end,
          timeoutMs: Map.get(body, "timeoutMs")
        })

      type when type in ["ProcessCompleted", "ProcessFailed", "ProcessCancelled"] ->
        format_summary(%{
          name: Map.get(body, "name"),
          key: Map.get(body, "key"),
          attempt: Map.get(body, "attempt"),
          exitCode: Map.get(body, "exitCode"),
          signal: Map.get(body, "signalCode"),
          stdout: Map.get(body, "stdoutRef"),
          stderr: Map.get(body, "stderrRef"),
          family: Map.get(body, "retryFamily"),
          retry: Map.get(body, "retryDecision"),
          retryable: Map.get(body, "retryable"),
          willRetry: Map.get(body, "willRetry"),
          backoffKind: Map.get(body, "backoffKind"),
          backoffMs: Map.get(body, "backoffMs"),
          backoffBaseMs: Map.get(body, "backoffBaseMs"),
          backoffCappedMs: Map.get(body, "backoffCappedMs"),
          backoffJitterKind: Map.get(body, "backoffJitterKind"),
          backoffJitterMs: Map.get(body, "backoffJitterMs"),
          error: if(type == "ProcessCompleted", do: nil, else: error_message(Map.get(body, "error")))
        })

      type when type in ["WaitRegistered", "WaitSatisfied"] ->
        format_summary(%{
          kind: Map.get(body, "kind"),
          key: Map.get(body, "key"),
          name: Map.get(body, "name") || Map.get(body, "signal"),
          wakeAt: Map.get(body, "wakeAt"),
          payload:
            if(Map.has_key?(body, "payload"), do: truncate_json(Map.get(body, "payload")), else: nil)
        })

      "RunSuspended" ->
        format_summary(%{
          reason: Map.get(body, "reason"),
          key: Map.get(body, "key"),
          operation: Map.get(body, "operationKind"),
          name: Map.get(body, "name"),
          wakeAt: Map.get(body, "wakeAt")
        })

      "RetryScheduled" ->
        format_summary(%{
          kind: Map.get(body, "kind"),
          name: Map.get(body, "name"),
          attempt: Map.get(body, "attempt"),
          nextAttempt: Map.get(body, "nextAttempt"),
          backoffKind: Map.get(body, "backoffKind"),
          backoffMs: Map.get(body, "backoffMs"),
          backoffBaseMs: Map.get(body, "backoffBaseMs"),
          backoffCappedMs: Map.get(body, "backoffCappedMs"),
          backoffCapMs: Map.get(body, "backoffCapMs"),
          backoffJitterKind: Map.get(body, "backoffJitterKind"),
          backoffJitterRatio: Map.get(body, "backoffJitterRatio"),
          backoffJitterMs: Map.get(body, "backoffJitterMs"),
          wakeAt: Map.get(body, "wakeAt")
        })

      type when type in ["SignalReceived", "SignalSent"] ->
        format_summary(%{
          signal: Map.get(body, "signal"),
          payload:
            if(Map.has_key?(body, "payload"), do: truncate_json(Map.get(body, "payload")), else: nil)
        })

      "ChildRunSpawned" ->
        format_summary(%{
          key: Map.get(body, "key"),
          childRunId: Map.get(body, "childRunId"),
          definition: Map.get(body, "definitionName"),
          status: Map.get(body, "childStatus")
        })

      "InboundEnqueued" ->
        format_summary(%{
          envelope: Map.get(body, "envelopeId"),
          kind: Map.get(body, "kind"),
          name: Map.get(body, "name"),
          correlation: Map.get(body, "correlationId"),
          sender: Map.get(body, "senderRunId")
        })

      type when type in ["TurnStarted", "TurnResumed", "TurnWaiting", "TurnCompleted", "TurnFailed"] ->
        format_summary(%{
          envelope: Map.get(body, "envelopeId"),
          kind: Map.get(body, "kind"),
          name: Map.get(body, "name") || Map.get(body, "turnName"),
          attempt: Map.get(body, "attempt"),
          reason: Map.get(body, "reason"),
          wait: Map.get(body, "waitKind"),
          key: Map.get(body, "key"),
          family: Map.get(body, "retryFamily"),
          retry: Map.get(body, "retryDecision"),
          retryable: Map.get(body, "retryable"),
          willRetry: Map.get(body, "willRetry"),
          backoffKind: Map.get(body, "backoffKind"),
          backoffMs: Map.get(body, "backoffMs"),
          backoffBaseMs: Map.get(body, "backoffBaseMs"),
          backoffCappedMs: Map.get(body, "backoffCappedMs"),
          backoffJitterKind: Map.get(body, "backoffJitterKind"),
          backoffJitterMs: Map.get(body, "backoffJitterMs"),
          error: if(type == "TurnFailed", do: error_message(Map.get(body, "error")), else: nil)
        })

      type when type in ["ServiceInstantiated", "ServiceInitialized", "ServiceStateCommitted", "AskRequested", "AskReplyCommitted", "MessageSent", "TimerFired"] ->
        format_summary(body)

      _ ->
        format_summary(body)
    end
  end

  defp body_record(%{} = value), do: value
  defp body_record(_value), do: %{}

  defp format_summary(fields) do
    parts =
      fields
      |> Enum.filter(fn {_key, value} -> not is_nil(value) end)
      |> Enum.map(fn {key, value} -> "#{key}=#{format_value(value)}" end)

    case parts do
      [] -> ""
      _ -> "\t" <> Enum.join(parts, "\t")
    end
  end

  defp format_value(value) when is_binary(value), do: value
  defp format_value(value) when is_number(value) or is_boolean(value) or is_atom(value), do: to_string(value)
  defp format_value(value), do: value |> Jason.encode!() |> truncate_value()

  defp truncate_json(value, max_length \\ 120) do
    value
    |> Jason.encode!()
    |> truncate_value(max_length)
  end

  defp truncate_value(value, max_length \\ 120) when is_binary(value) do
    if String.length(value) <= max_length do
      value
    else
      String.slice(value, 0, max_length) <> "..."
    end
  end

  defp error_message(%{} = value), do: Map.get(value, "message")
  defp error_message(_value), do: nil

  defp maybe_kill_managed_worker(result) do
    case Map.get(result, "activeLeaseWorkerId") do
      worker_id when is_binary(worker_id) ->
        _ = VilanoKernel.ManagedWorker.kill_worker(worker_id, :activation_cancelled)
        :ok

      _ ->
        :ok
    end
  end

  defp send_json(conn, status, body) do
    body = Jason.encode!(body)

    conn
    |> Conn.put_resp_content_type("application/json")
    |> Conn.send_resp(status, body <> "\n")
  end

  defp send_error(conn, status, code, message) do
    send_json(conn, status, %{ok: false, error: %{code: code, message: message}})
  end

  @impl Plug.ErrorHandler
  def handle_errors(conn, %{reason: reason}) do
    message =
      cond do
        is_exception(reason) -> Exception.message(reason)
        true -> inspect(reason)
      end

    send_json(conn, conn.status || 500, %{ok: false, error: %{code: "internal_error", message: message}})
  end
end
