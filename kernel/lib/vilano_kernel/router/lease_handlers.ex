defmodule VilanoKernel.Router.LeaseHandlers do
  @moduledoc false

  alias VilanoKernel.Storage
  alias VilanoKernel.WaitManager

  import VilanoKernel.Router.Support

  def lease_activation(conn) do
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
            run: %{id: run["id"], input: run["input"]},
            project: %{name: run["project"], path: run["projectSnapshotPath"]},
            definition: run["definition"]
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
            run: %{id: run["id"]},
            project: %{name: run["project"], path: run["projectSnapshotPath"]},
            definition: run["definition"],
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

  def heartbeat(conn, lease_id) do
    worker_id = fetch_required_string(conn.body_params, "workerId")

    case Storage.heartbeat_lease(lease_id, worker_id) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      lease -> send_json(conn, 200, %{ok: true, lease: lease})
    end
  end

  def lease_status(conn, lease_id) do
    send_json(conn, 200, %{ok: true, lease: Storage.lease_status(lease_id)})
  end

  def related_run_status(conn, lease_id, id) do
    case Storage.get_related_run_status(lease_id, id) do
      nil -> send_error(conn, 404, "not_found", "Unknown related run for active lease: #{id}")
      run -> send_json(conn, 200, %{ok: true, run: run})
    end
  end

  def monitor_run(conn, lease_id, id) do
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_run_monitor(lease_id, id, key) do
      nil -> send_error(conn, 404, "not_found", "Unknown related run for active lease: #{id}")
      relationship -> send_json(conn, 200, %{ok: true, relationship: relationship})
    end
  end

  def link_run(conn, lease_id, id) do
    key = fetch_required_string(conn.body_params, "key")
    propagate = Map.get(conn.body_params, "propagate", "abnormal")

    case Storage.resolve_run_link(lease_id, id, key, propagate) do
      nil -> send_error(conn, 404, "not_found", "Unknown related run for active lease: #{id}")
      relationship -> send_json(conn, 200, %{ok: true, relationship: relationship})
    end
  end

  def trap_exits(conn, lease_id) do
    enabled = Map.get(conn.body_params, "enabled", true)

    case Storage.set_trap_exits(lease_id, enabled in [true, "true", 1, "1", "yes"]) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      run -> send_json(conn, 200, %{ok: true, run: run})
    end
  end

  def signal_child_run(conn, lease_id, id) do
    name = fetch_required_string(conn.body_params, "name")
    payload = Map.get(conn.body_params, "payload")

    case Storage.send_child_run_signal(lease_id, id, name, payload) do
      nil -> send_error(conn, 404, "not_found", "Unknown child run for active lease: #{id}")
      signal -> send_json(conn, 200, %{ok: true, signal: signal})
    end
  end

  def complete_run(conn, lease_id) do
    case Storage.complete_run_lease(lease_id, Map.get(conn.body_params, "result", %{})) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      run -> send_json(conn, 200, %{ok: true, run: run})
    end
  end

  def fail_run(conn, lease_id) do
    error_body = Map.get(conn.body_params, "error", %{})

    case Storage.fail_run_lease(lease_id, error_body) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      run -> send_json(conn, 200, %{ok: true, run: run})
    end
  end

  def resolve_step(conn, lease_id) do
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

  def complete_step(conn, lease_id) do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.complete_step(lease_id, name, key, Map.get(conn.body_params, "output")) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      step -> send_json(conn, 200, %{ok: true, step: step})
    end
  end

  def fail_step(conn, lease_id) do
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

  def resolve_exec(conn, lease_id) do
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

  def complete_exec(conn, lease_id) do
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

  def fail_exec(conn, lease_id) do
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

  def resolve_sleep_wait(conn, lease_id) do
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

  def resolve_signal_wait(conn, lease_id) do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_signal_wait(lease_id, name, key) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      wait -> send_json(conn, 200, %{ok: true, wait: wait})
    end
  end

  def resolve_exit_wait(conn, lease_id) do
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_exit_wait(lease_id, key) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
      wait -> send_json(conn, 200, %{ok: true, wait: wait})
    end
  end

  def resolve_supervision_group(conn, lease_id) do
    key = fetch_required_string(conn.body_params, "key")
    strategy = fetch_required_string(conn.body_params, "strategy")
    max_restarts = fetch_required_integer(conn.body_params, "maxRestarts")
    window_ms = fetch_required_integer(conn.body_params, "windowMs")
    on_exhausted = Map.get(conn.body_params, "onExhausted", "fail_self")

    cond do
      strategy not in ["one_for_one", "one_for_all"] ->
        send_error(conn, 400, "invalid_argument", "Unsupported supervision strategy: #{strategy}")

      on_exhausted not in ["fail_self"] ->
        send_error(
          conn,
          400,
          "invalid_argument",
          "Unsupported supervision exhaustion policy: #{on_exhausted}"
        )

      max_restarts < 0 ->
        send_error(conn, 400, "invalid_argument", "maxRestarts must be >= 0")

      window_ms <= 0 ->
        send_error(conn, 400, "invalid_argument", "windowMs must be > 0")

      true ->
        case Storage.resolve_supervision_group(
               lease_id,
               key,
               strategy,
               max_restarts,
               window_ms,
               on_exhausted
             ) do
          nil -> send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")
          group -> send_json(conn, 200, %{ok: true, group: group})
        end
    end
  end

  def resolve_supervised_spawn(conn, lease_id, group_id) do
    name = fetch_required_string(conn.body_params, "name")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_supervised_spawn(
           lease_id,
           group_id,
           name,
           key,
           Map.get(conn.body_params, "input", %{})
         ) do
      nil ->
        send_error(
          conn,
          404,
          "not_found",
          "Unknown active lease or supervision group: #{group_id}"
        )

      member ->
        send_json(conn, 200, %{ok: true, member: member})
    end
  end

  def list_supervision_members(conn, lease_id, group_id) do
    case Storage.list_supervision_members(lease_id, group_id) do
      nil ->
        send_error(
          conn,
          404,
          "not_found",
          "Unknown active lease or supervision group: #{group_id}"
        )

      members ->
        send_json(conn, 200, %{ok: true, members: members})
    end
  end

  def resolve_supervision_member_result_wait(conn, lease_id, group_id, member_key) do
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_supervision_member_result_wait(lease_id, group_id, member_key, key) do
      nil ->
        send_error(
          conn,
          404,
          "not_found",
          "Unknown active lease or supervision member: #{group_id}/#{member_key}"
        )

      member ->
        send_json(conn, 200, %{ok: true, member: member})
    end
  end

  def get_supervision_member_status(conn, lease_id, group_id, member_key) do
    case Storage.get_supervision_member_status(lease_id, group_id, member_key) do
      nil ->
        send_error(
          conn,
          404,
          "not_found",
          "Unknown active lease or supervision member: #{group_id}/#{member_key}"
        )

      member ->
        send_json(conn, 200, %{ok: true, member: member})
    end
  end

  def resolve_spawn(conn, lease_id) do
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

  def resolve_child_result_wait(conn, lease_id) do
    child_run_id = fetch_required_string(conn.body_params, "childRunId")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_child_result_wait(lease_id, child_run_id, key) do
      nil -> send_error(conn, 404, "not_found", "Unknown active lease or child run: #{lease_id}")
      child -> send_json(conn, 200, %{ok: true, child: child})
    end
  end

  def resolve_service_send(conn, lease_id) do
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

  def lookup_singleton_service(conn, lease_id) do
    role = fetch_required_string(conn.body_params, "role")

    case Storage.lookup_singleton_service(
           lease_id,
           role,
           Map.get(conn.body_params, "keyInput", %{})
         ) do
      nil ->
        send_error(
          conn,
          404,
          "not_found",
          "Unknown active lease or singleton service role: #{role}"
        )

      run ->
        send_json(conn, 200, %{ok: true, run: run})
    end
  end

  def publish_topic(conn, lease_id) do
    topic = fetch_required_string(conn.body_params, "topic")
    key = fetch_required_string(conn.body_params, "key")

    case Storage.resolve_topic_publish(lease_id, topic, key, Map.get(conn.body_params, "payload")) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown active lease: #{lease_id}")

      publish ->
        send_json(conn, 200, %{ok: true, publish: publish})
    end
  end

  def subscribe_topic(conn, lease_id) do
    topic = fetch_required_string(conn.body_params, "topic")
    signal_name = fetch_required_string(conn.body_params, "signal")

    case Storage.subscribe_service_topic(lease_id, topic, signal_name) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown active service lease: #{lease_id}")

      subscription ->
        send_json(conn, 200, %{ok: true, subscription: subscription})
    end
  end

  def unsubscribe_topic(conn, lease_id) do
    topic = fetch_required_string(conn.body_params, "topic")
    signal_name = fetch_required_string(conn.body_params, "signal")

    case Storage.unsubscribe_service_topic(lease_id, topic, signal_name) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown active service lease: #{lease_id}")

      _result ->
        send_json(conn, 200, %{ok: true})
    end
  end

  def resolve_service_ask(conn, lease_id) do
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

  def resolve_service_signal(conn, lease_id) do
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

  def complete_service_turn(conn, lease_id, envelope_id) do
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

  def get_service_turn_mailbox(conn, lease_id, envelope_id) do
    case Storage.get_service_turn_mailbox(lease_id, envelope_id) do
      nil -> send_error(conn, 404, "not_found", "Unknown active service turn: #{lease_id}")
      mailbox -> send_json(conn, 200, %{ok: true, mailbox: mailbox})
    end
  end

  def defer_service_turn(conn, lease_id, envelope_id) do
    delay_ms = fetch_required_integer(conn.body_params, "delayMs")
    reason = Map.get(conn.body_params, "reason")

    case Storage.defer_service_turn(lease_id, envelope_id, delay_ms, reason) do
      nil ->
        send_error(conn, 404, "not_found", "Unknown active service turn: #{lease_id}")

      %{"run" => run} = result ->
        send_json(conn, 200, %{ok: true, run: run, wait: Map.get(result, "wait")})
    end
  end

  def reject_service_turn(conn, lease_id, envelope_id) do
    error_body = Map.get(conn.body_params, "error", %{})

    case Storage.reject_service_turn(lease_id, envelope_id, error_body) do
      nil -> send_error(conn, 404, "not_found", "Unknown active service turn: #{lease_id}")
      run -> send_json(conn, 200, %{ok: true, run: run})
    end
  end

  def fail_service_turn(conn, lease_id, envelope_id) do
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
end
