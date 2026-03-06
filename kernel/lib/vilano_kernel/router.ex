defmodule VilanoKernel.Router do
  @moduledoc false

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

    send_json(conn, 200, %{
      ok: true,
      port: runtime.port,
      startedAt: runtime.started_at,
      runtimeDbPath: runtime.runtime_db_path,
      projectCount: Storage.project_count()
    })
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

  get "/v1/workflows/:project/:name" do
    case Storage.get_definition(project, "workflow", name) do
      nil -> send_error(conn, 404, "not_found", "Unknown workflow '#{name}' in project '#{project}'")
      definition -> send_json(conn, 200, %{ok: true, project: project, definition: definition})
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

    case Storage.resolve_step(lease_id, name, key) do
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
      "error" => Map.get(conn.body_params, "error", %{})
    }

    case Storage.fail_exec(lease_id, name, key, body) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      exec -> send_json(conn, 200, %{ok: true, exec: exec})
    end
  end

  post "/v1/leases/:lease_id/waits/sleep" do
    key = fetch_required_string(conn.body_params, "key")
    duration_ms = fetch_required_integer(conn.body_params, "durationMs")

    case Storage.resolve_sleep_wait(lease_id, key, duration_ms) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")

      %{"status" => "suspended", "wait" => wait} = body ->
        WaitManager.schedule_sleep(wait)
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

    case Storage.fail_service_turn(lease_id, envelope_id, error_body) do
      nil -> send_error(conn, 404, "not_found", "Unknown active service turn: #{lease_id}")
      run -> send_json(conn, 200, %{ok: true, run: run})
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
    case Storage.get_run(id) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown run: #{id}")

      run ->
        send_json(conn, 200, %{
          ok: true,
          run: run,
          events: Storage.list_run_events(id),
          steps: Storage.list_run_steps(id),
          execs: Storage.list_run_execs(id),
          waits: Storage.list_run_waits(id),
          signals: Storage.list_run_signals(id),
          children: Storage.list_run_children(id),
          envelopes: Storage.list_service_envelopes(id)
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

  defp send_json(conn, status, body) do
    body = Jason.encode!(body)

    conn
    |> Conn.put_resp_content_type("application/json")
    |> Conn.send_resp(status, body <> "\n")
  end

  defp send_error(conn, status, code, message) do
    send_json(conn, status, %{ok: false, error: %{code: code, message: message}})
  end
end
