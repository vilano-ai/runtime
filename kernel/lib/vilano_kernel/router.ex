defmodule VilanoKernel.Router do
  @moduledoc false

  use Plug.ErrorHandler
  use Plug.Router

  alias Plug.Conn
  alias VilanoKernel.Router.Support
  alias VilanoKernel.Storage
  alias VilanoKernel.WaitManager
  import VilanoKernel.Router.Support

  plug(:match)

  plug(Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason
  )

  plug(:authenticate_request)
  plug(:dispatch)

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
      executionHomeDir: runtime.execution_home_dir,
      projectRoot: runtime.project_root,
      runtimeDbPath: runtime.runtime_db_path,
      managedWorkerCount: runtime.managed_worker_count,
      managedWorkerRuntime: runtime.managed_worker_runtime,
      leaseDurationSeconds: runtime.lease_duration_seconds,
      projectCount: Storage.project_count()
    })
  end

  defp authenticate_request(conn, _opts) do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)

    provided =
      conn
      |> Conn.get_req_header("x-vilano-token")
      |> List.first()

    lease_scope = lease_auth_scope(conn, provided)

    cond do
      valid_auth_token?(provided, runtime.auth_token) ->
        Conn.assign(conn, :auth_scope, :daemon)

      lease_scope != nil ->
        conn
        |> Conn.assign(:auth_scope, :lease)
        |> Conn.assign(:lease_id, lease_scope)

      valid_auth_token?(provided, runtime.worker_auth_token) ->
        if worker_bootstrap_request?(conn.method, conn.request_path) do
          Conn.assign(conn, :auth_scope, :worker_bootstrap)
        else
          conn
          |> send_error(401, "unauthorized", "Vilano worker token cannot access this endpoint")
          |> Conn.halt()
        end

      auth_configured?(runtime) ->
        conn
        |> send_error(401, "unauthorized", "Vilano kernel access token is missing or invalid")
        |> Conn.halt()

      conn.request_path == "/v1/status" ->
        conn

      true ->
        conn
        |> send_error(503, "unconfigured_auth", "Vilano kernel access tokens are not configured")
        |> Conn.halt()
    end
  end

  defp auth_configured?(runtime) do
    non_empty_token?(runtime.auth_token) or non_empty_token?(runtime.worker_auth_token)
  end

  defp non_empty_token?(token) when is_binary(token), do: token != ""
  defp non_empty_token?(_token), do: false

  defp worker_bootstrap_request?("GET", "/v1/status"), do: true
  defp worker_bootstrap_request?("POST", "/v1/activations/lease"), do: true
  defp worker_bootstrap_request?(_method, _path), do: false

  defp lease_auth_scope(_conn, token) when not is_binary(token) or token == "", do: nil

  defp lease_auth_scope(conn, token) do
    case requested_lease_id(conn) do
      lease_id when is_binary(lease_id) and lease_id != "" ->
        if Storage.valid_lease_auth_token?(lease_id, token), do: lease_id, else: nil

      _ ->
        nil
    end
  end

  defp requested_lease_id(%Conn{request_path: path, body_params: body_params}) do
    case Regex.run(~r{^/v1/leases/([^/]+)(?:/|$)}, path, capture: :all_but_first) do
      [lease_id] ->
        URI.decode_www_form(lease_id)

      _ ->
        case path do
          "/v1/services/ensure" ->
            case Map.get(body_params, "leaseId") do
              value when is_binary(value) and value != "" -> value
              _ -> nil
            end

          _ ->
            nil
        end
    end
  end

  defp valid_auth_token?(provided, expected)
       when is_binary(provided) and is_binary(expected) and
              byte_size(provided) == byte_size(expected) do
    Plug.Crypto.secure_compare(provided, expected)
  end

  defp valid_auth_token?(_provided, _expected), do: false

  post "/v1/admin/shutdown" do
    send_json(conn, 200, %{ok: true, shuttingDown: true})

    Task.start(fn ->
      Process.sleep(50)
      System.stop(0)
    end)
  end

  get "/v1/admin/project-snapshots" do
    project_name =
      conn
      |> Conn.fetch_query_params()
      |> then(& &1.query_params["project"])

    send_json(conn, 200, %{
      ok: true,
      project: project_name,
      snapshotPaths: Storage.list_referenced_snapshot_paths(project_name)
    })
  end

  get "/v1/projects" do
    send_json(conn, 200, %{
      ok: true,
      projects: Storage.list_projects()
    })
  end

  post "/v1/projects" do
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

  get "/v1/projects/:name" do
    case Storage.get_project(name) do
      nil -> send_error(conn, 404, "not_found", "Unknown project: #{name}")
      project -> send_json(conn, 200, %{ok: true, project: project})
    end
  end

  post "/v1/projects/:name/sync" do
    case validate_project_payload(Map.put(conn.body_params, "name", name)) do
      {:ok, project_payload} ->
        project = Storage.upsert_project!(project_payload)
        send_json(conn, 200, %{ok: true, project: project})

      {:error, message} ->
        send_error(conn, 400, "invalid_project", message)
    end
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

  get "/v1/workflows/:project/:name" do
    case Storage.get_definition(project, "workflow", name) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown workflow '#{name}' in project '#{project}'")

      definition ->
        send_json(conn, 200, %{ok: true, project: project, definition: definition})
    end
  end

  get "/v1/services/:project/:name/runs/:service_key" do
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

      %{
        activation_kind: "workflow",
        lease_id: lease_id,
        lease_auth_token: lease_auth_token,
        lease_expires_at: lease_expires_at,
        run: run
      } ->
        send_json(conn, 200, %{
          ok: true,
          activation: %{
            kind: "workflow",
            leaseId: lease_id,
            leaseToken: lease_auth_token,
            leaseExpiresAt: lease_expires_at,
            run: %{
              id: run["id"],
              input: run["input"]
            },
            project: %{
              name: run["project"],
              path: activation_project_path(run)
            },
            definition: activation_definition(run)
          }
        })

      %{
        activation_kind: "service_turn",
        lease_id: lease_id,
        lease_auth_token: lease_auth_token,
        lease_expires_at: lease_expires_at,
        run: run,
        service: service,
        envelope: envelope
      } ->
        send_json(conn, 200, %{
          ok: true,
          activation: %{
            kind: "service_turn",
            leaseId: lease_id,
            leaseToken: lease_auth_token,
            leaseExpiresAt: lease_expires_at,
            run: %{
              id: run["id"]
            },
            project: %{
              name: run["project"],
              path: activation_project_path(run)
            },
            definition: activation_definition(run),
            service: %{
              key: service["serviceKey"],
              keyInput: service["keyInput"],
              state: service["state"]
            },
            envelope: %{
              id: envelope["id"],
              kind: envelope["kind"],
              name: envelope["name"],
              attempt: envelope["attempt"],
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

  get "/v1/leases/:lease_id/runs/:id/status" do
    case Storage.get_related_run_status(lease_id, id) do
      nil -> send_error(conn, 404, "not_found", "Unknown related run for active lease: #{id}")
      run -> send_json(conn, 200, %{ok: true, run: run})
    end
  end

  post "/v1/leases/:lease_id/runs/:id/monitor" do
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_run_monitor(lease_id, id, key) do
      nil -> send_error(conn, 404, "not_found", "Unknown related run for active lease: #{id}")
      relationship -> send_json(conn, 200, %{ok: true, relationship: relationship})
    end
  end

  post "/v1/leases/:lease_id/runs/:id/link" do
    key = fetch_required_string(conn.body_params, "key")
    propagate = Map.get(conn.body_params, "propagate", "abnormal")

    case Storage.resolve_run_link(lease_id, id, key, propagate) do
      nil -> send_error(conn, 404, "not_found", "Unknown related run for active lease: #{id}")
      relationship -> send_json(conn, 200, %{ok: true, relationship: relationship})
    end
  end

  post "/v1/leases/:lease_id/trap-exits" do
    enabled = Map.get(conn.body_params, "enabled", true)

    case Storage.set_trap_exits(lease_id, enabled in [true, "true", 1, "1", "yes"]) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      run -> send_json(conn, 200, %{ok: true, run: run})
    end
  end

  post "/v1/leases/:lease_id/runs/:id/signals" do
    name = fetch_required_string(conn.body_params, "name")
    payload = Map.get(conn.body_params, "payload")

    case Storage.send_child_run_signal(lease_id, id, name, payload) do
      nil -> send_error(conn, 404, "not_found", "Unknown child run for active lease: #{id}")
      signal -> send_json(conn, 200, %{ok: true, signal: signal})
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
      nil ->
        send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")

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
      nil ->
        send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")

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

  post "/v1/leases/:lease_id/waits/exit" do
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_exit_wait(lease_id, key) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      wait -> send_json(conn, 200, %{ok: true, wait: wait})
    end
  end

  post "/v1/leases/:lease_id/spawns/resolve" do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")
    child_run_id = fetch_required_string(conn.body_params, "childRunId")

    case Storage.resolve_spawn(
           lease_id,
           name,
           key,
           child_run_id,
           Map.get(conn.body_params, "input", %{})
         ) do
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

    case Storage.resolve_service_send(
           lease_id,
           service_run_id,
           name,
           key,
           Map.get(conn.body_params, "payload")
         ) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease or service: #{lease_id}")
      result -> send_json(conn, 200, %{ok: true, result: result})
    end
  end

  post "/v1/leases/:lease_id/services/ask" do
    service_run_id = fetch_required_string(conn.body_params, "serviceRunId")
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")
    timeout_ms = fetch_optional_integer(conn.body_params, "timeoutMs")

    case Storage.resolve_service_ask(
           lease_id,
           service_run_id,
           name,
           key,
           Map.get(conn.body_params, "payload"),
           timeout_ms
         ) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown active lease or service: #{lease_id}")

      %{"status" => "suspended", "wait" => %{"wakeAt" => wake_at} = wait} = result
      when not is_nil(wake_at) ->
        WaitManager.schedule_timed_wait(wait)
        send_json(conn, 200, %{ok: true, result: result})

      result ->
        send_json(conn, 200, %{ok: true, result: result})
    end
  end

  post "/v1/leases/:lease_id/services/signal" do
    service_run_id = fetch_required_string(conn.body_params, "serviceRunId")
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_service_signal(
           lease_id,
           service_run_id,
           name,
           key,
           Map.get(conn.body_params, "payload")
         ) do
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
      nil ->
        send_error(conn, 404, "not_found", "Unknown active service turn: #{lease_id}")

      %{"status" => "retry_waiting", "run" => run, "wait" => wait} ->
        WaitManager.schedule_timed_wait(wait)
        send_json(conn, 200, %{ok: true, run: run, wait: wait, status: "retry_waiting"})

      run ->
        send_json(conn, 200, %{ok: true, run: run})
    end
  end

  post "/v1/services/ensure" do
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

  post "/v1/services/:project/:name/runs/:service_key/send" do
    with project_record when not is_nil(project_record) <- Storage.get_project(project),
         definition when not is_nil(definition) <-
           Storage.get_definition(project, "service", name),
         result <-
           Storage.enqueue_service_envelope!(
             project_record,
             definition,
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
         definition when not is_nil(definition) <-
           Storage.get_definition(project, "service", name),
         result <-
           Storage.enqueue_service_envelope!(
             project_record,
             definition,
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
         definition when not is_nil(definition) <-
           Storage.get_definition(project, "service", name),
         result <-
           Storage.enqueue_service_envelope!(
             project_record,
             definition,
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

  post "/v1/runs" do
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
          nil ->
            send_error(conn, 404, "not_found", "Unknown project: #{name}")

          _project ->
            send_json(conn, 200, %{ok: true, project: name, runs: Storage.list_runs(name)})
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

  defp resolve_service_definition(body_params, service_name) do
    case Map.get(body_params, "leaseId") do
      lease_id when is_binary(lease_id) and lease_id != "" ->
        with run when not is_nil(run) <- Storage.get_active_run_by_lease(lease_id),
             definition when not is_nil(definition) <-
               find_definition_in_run(run, "service", service_name) do
          {
            %{
              "name" => run["project"],
              "path" => activation_project_path(run),
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

  defp activation_project_path(run) do
    run["projectSnapshotPath"]
  end

  defp activation_definition(run) do
    run["definition"]
  end

  match _ do
    send_error(conn, 404, "not_found", "Unknown endpoint: #{conn.method} #{conn.request_path}")
  end

  @impl Plug.ErrorHandler
  def handle_errors(conn, %{reason: reason}) do
    message =
      cond do
        is_exception(reason) -> Exception.message(reason)
        true -> inspect(reason)
      end

    Support.send_json(conn, conn.status || 500, %{
      ok: false,
      error: %{code: "internal_error", message: message}
    })
  end
end
