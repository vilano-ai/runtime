defmodule VilanoKernel.Storage do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Diagnostics
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{
    ActivationLifecycle,
    AgentTopology,
    EventPayloads,
    Infrastructure,
    Projects,
    Prune,
    ReadModels,
    RunControl,
    RuntimeMetadata,
    ServiceOps,
    ServiceSupport,
    Support,
    Supervision,
    WorkflowOps,
    AgentRelationships,
    FailureRecovery
  }

  import Support
  import ServiceSupport

  def init! do
    Infrastructure.init!()
  end

  def project_count, do: Projects.project_count()
  def schema_state, do: RuntimeMetadata.schema_state()
  def runtime_metadata, do: RuntimeMetadata.runtime_metadata()
  def runtime_diagnostics, do: Diagnostics.snapshot()
  def list_projects, do: Projects.list_projects()
  def get_project(name), do: Projects.get_project(name)
  def create_project!(project), do: Projects.create_project(project)
  def upsert_project!(project), do: Projects.upsert_project!(project)
  def remove_project(name), do: Projects.remove_project(name)

  def valid_lease_auth_token?(lease_id, lease_auth_token),
    do: RunControl.lease_auth_token_valid?(lease_id, lease_auth_token)

  def list_definitions(kind, project_name \\ nil),
    do: Projects.list_definitions(kind, project_name)

  def get_definition(project_name, kind, definition_name),
    do: Projects.get_definition(project_name, kind, definition_name)

  def find_definition(project, kind, definition_name),
    do: Projects.find_definition(project, kind, definition_name)

  def get_active_run_by_lease(lease_id), do: RunControl.get_run_by_lease(lease_id)

  def list_referenced_snapshot_paths(project_name \\ nil) do
    args =
      case project_name do
        nil -> []
        value -> [value, value]
      end

    where_clause =
      case project_name do
        nil ->
          """
          where snapshot_path is not null
          union
          select distinct project_snapshot_path as snapshot_path
          from runs
          where
            project_snapshot_path is not null
            and status in ('pending', 'running', 'waiting', 'active', 'idle')
          """

        _ ->
          """
          where snapshot_path is not null and name = ?
          union
          select distinct project_snapshot_path as snapshot_path
          from runs
          where
            project_snapshot_path is not null
            and project_name = ?
            and status in ('pending', 'running', 'waiting', 'active', 'idle')
          """
      end

    Infrastructure.run_with_busy_retry(
      fn ->
        Repo
        |> SQL.query!(
          """
          select distinct snapshot_path
          from projects
          #{where_clause}
          order by snapshot_path asc
          """,
          args
        )
        |> rows_to_maps()
        |> Enum.map(& &1["snapshot_path"])
        |> Enum.filter(&is_binary/1)
      end,
      :public_read
    )
  end

  def create_workflow_run!(project, definition, input) do
    now = Infrastructure.now_iso8601()
    run_id = "run_" <> Ecto.UUID.generate()
    input = input || %{}

    prepared_insert =
      Support.Sql.prepare_workflow_run_insert!(project, definition, input)

    try do
      Infrastructure.transaction_with_busy_retry(
        fn ->
          Support.Sql.insert_workflow_run!(
            run_id,
            project,
            definition,
            input,
            now,
            prepared_insert
          )
        end,
        :run_creation
      )
    after
      Support.Sql.discard_prepared_workflow_run_insert!(prepared_insert)
    end

    get_run(run_id)
  end

  def ensure_service_run!(
        project,
        definition,
        service_key,
        key_input,
        lease_id \\ nil,
        must_exist \\ false
      ) do
    now = Infrastructure.now_iso8601()

    prepared_instantiated_event =
      prepare_service_instantiated_event(project, definition, service_key, key_input, must_exist)

    try do
      Infrastructure.transaction_with_busy_retry(
        fn ->
          caller_run =
            case lease_id do
              value when is_binary(value) and value != "" ->
                RunControl.get_fenced_run_by_lease(value, now)

              _ ->
                nil
            end

          if is_binary(lease_id) and lease_id != "" and is_nil(caller_run) do
            nil
          else
            RunControl.ensure_service_run_in_tx!(
              project,
              definition,
              service_key,
              key_input,
              now,
              caller_run && caller_run["id"],
              lease_id,
              must_exist,
              prepared_instantiated_event
            )
          end
        end,
        :run_creation
      )
      |> unwrap_transaction_result()
    after
      RunControl.discard_prepared_service_instantiated_event(prepared_instantiated_event)
    end
  end

  defp prepare_service_instantiated_event(_project, _definition, _service_key, _key_input, true),
    do: nil

  defp prepare_service_instantiated_event(project, definition, service_key, key_input, false) do
    Infrastructure.run_with_busy_retry(
      fn ->
        project_name = Map.fetch!(project, "name")
        definition_name = Map.fetch!(definition, "name")

        if get_service_run(project_name, definition_name, service_key) do
          nil
        else
          RunControl.prepare_service_instantiated_event(
            project,
            definition,
            service_key,
            key_input || %{}
          )
        end
      end,
      :public_read
    )
  end

  def find_service_run(project_name, definition_name, service_key) do
    get_service_run(project_name, definition_name, service_key)
  end

  def get_related_run_status(lease_id, run_id) do
    now = Infrastructure.now_iso8601()

    with caller_run when not is_nil(caller_run) <-
           RunControl.get_fenced_run_by_lease(lease_id, now),
         true <- related_run?(caller_run["id"], run_id),
         run when not is_nil(run) <- get_run(run_id) do
      %{"status" => run["status"]}
    else
      _ -> nil
    end
  end

  def send_child_run_signal(lease_id, child_run_id, signal_name, payload) do
    now = Infrastructure.now_iso8601()

    Infrastructure.transaction_with_busy_retry(fn ->
      with caller_run when not is_nil(caller_run) <-
             RunControl.get_fenced_run_by_lease(lease_id, now),
           child_ref when not is_nil(child_ref) <-
             get_run_child_by_child(caller_run["id"], child_run_id) do
        _ = child_ref
        RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)
        result = ActivationLifecycle.send_run_signal(child_run_id, signal_name, payload)
        RunControl.ensure_fenced_run_ownership!(caller_run["id"], lease_id, now)
        result
      else
        _ -> nil
      end
    end)
    |> unwrap_transaction_result()
  end

  def enqueue_service_envelope!(project, definition, service_key, key_input, kind, name, payload) do
    now = Infrastructure.now_iso8601()

    prepared_enqueue =
      prepare_external_service_enqueue_plan(
        project,
        definition,
        service_key,
        key_input,
        kind,
        name,
        payload
      )

    try do
      Infrastructure.transaction_with_busy_retry(fn ->
        service_run =
          RunControl.ensure_service_run_in_tx!(
            project,
            definition,
            service_key,
            key_input || %{},
            now,
            nil,
            nil,
            false,
            prepared_enqueue && prepared_enqueue.instantiated_event
          )

        prepared_enqueue =
          prepared_external_service_enqueue_plan!(prepared_enqueue, service_run, kind, name)

        case maybe_insert_service_envelope(
               service_run,
               kind,
               name,
               payload,
               nil,
               nil,
               now,
               prepared_enqueue.inbound_enqueued_event
             ) do
          {:ok, envelope_id} ->
            %{
              "run" => get_service_run_by_id(service_run["id"]),
              "envelope" => service_envelope_from_row(get_service_envelope(envelope_id))
            }

          {:error, error} ->
            {:error, error}
        end
      end)
      |> unwrap_transaction_result()
    after
      discard_external_service_enqueue_plan(prepared_enqueue)
    end
  end

  defp prepare_external_service_enqueue_plan(
         project,
         definition,
         service_key,
         key_input,
         kind,
         name,
         payload
       ) do
    Infrastructure.run_with_busy_retry(
      fn ->
        project_name = Map.fetch!(project, "name")
        definition_name = Map.fetch!(definition, "name")
        existing_service_run = get_service_run(project_name, definition_name, service_key)

        service_run =
          existing_service_run ||
            %{
              "id" => deterministic_service_run_id(project_name, definition_name, service_key)
            }

        instantiated_event =
          if existing_service_run do
            nil
          else
            RunControl.prepare_service_instantiated_event(
              project,
              definition,
              service_key,
              key_input || %{}
            )
          end

        inbound_enqueued_event =
          try do
            prepare_service_envelope_enqueue_event(service_run, kind, name, payload, nil, nil)
          rescue
            error ->
              RunControl.discard_prepared_service_instantiated_event(instantiated_event)
              reraise error, __STACKTRACE__
          end

        %{
          service_run_id: service_run["id"],
          kind: kind,
          name: name,
          instantiated_event: instantiated_event,
          inbound_enqueued_event: inbound_enqueued_event
        }
      end,
      :public_read
    )
  end

  defp prepared_external_service_enqueue_plan!(nil, _service_run, _kind, _name),
    do: Repo.rollback(:stale_cancellation_plan)

  defp prepared_external_service_enqueue_plan!(prepared_enqueue, service_run, kind, name)
       when is_map(prepared_enqueue) do
    if prepared_enqueue.service_run_id == service_run["id"] and prepared_enqueue.kind == kind and
         prepared_enqueue.name == name do
      prepared_enqueue
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp discard_external_service_enqueue_plan(nil), do: :ok

  defp discard_external_service_enqueue_plan(%{} = prepared_enqueue) do
    RunControl.discard_prepared_service_instantiated_event(prepared_enqueue.instantiated_event)
    discard_prepared_service_envelope_enqueue_event(prepared_enqueue.inbound_enqueued_event)
  end

  def find_service_envelope(envelope_id) do
    case get_service_envelope(envelope_id) do
      nil -> nil
      row -> service_envelope_from_row(row)
    end
  end

  def stop_service_run(project_name, definition_name, service_key) do
    initial_run =
      Infrastructure.run_with_busy_retry(
        fn -> get_service_run(project_name, definition_name, service_key) end,
        :admin_control
      )

    stop_service_run_with_prepared_payload_retry(
      initial_run,
      project_name,
      definition_name,
      service_key,
      3
    )
  end

  defp stop_service_run_with_prepared_payload_retry(
         initial_run,
         project_name,
         definition_name,
         service_key,
         attempts_left
       ) do
    Infrastructure.run_with_busy_retry(
      fn -> maybe_preempt_active_managed_worker(initial_run) end,
      :admin_control
    )

    now = Infrastructure.now_iso8601()
    reason = "cli_stop"
    error_body = FailureRecovery.cancellation_error("Service stopped", reason)

    prepared_stop =
      Infrastructure.run_with_busy_retry(
        fn ->
          prepare_service_stop_for_admin(
            project_name,
            definition_name,
            service_key,
            error_body,
            reason,
            now
          )
        end,
        :admin_control
      )

    try do
      case admin_control_transaction_with_optional_preemption(initial_run, fn ->
             case get_service_run(project_name, definition_name, service_key) do
               nil ->
                 nil

               service_run ->
                 if is_nil(prepared_stop) and service_run["status"] != "stopped" do
                   Repo.rollback(:stale_cancellation_plan)
                 end

                 FailureRecovery.stop_service_run_instance!(
                   service_run,
                   error_body,
                   reason,
                   now,
                   nil,
                   prepared_stop
                 )
             end
           end) do
        {:ok, result} ->
          result

        {:error, error} when attempts_left > 1 ->
          if stale_cancellation_preflight_error?(error) do
            stop_service_run_with_prepared_payload_retry(
              initial_run,
              project_name,
              definition_name,
              service_key,
              attempts_left - 1
            )
          else
            unwrap_transaction_result({:error, error})
          end

        {:error, error} when is_atom(error) ->
          if stale_cancellation_preflight_error?(error) do
            raise RuntimeError, "stale service stop plan after retries: #{error}"
          else
            unwrap_transaction_result({:error, error})
          end

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      FailureRecovery.ServiceFailure.discard_prepared_service_stop(prepared_stop)
    end
  end

  def cancel_run(run_id, reason \\ "cli_cancel") do
    initial_run =
      Infrastructure.run_with_busy_retry(fn -> get_run(run_id) end, :admin_control)

    cancel_run_with_prepared_payload_retry(initial_run, run_id, reason, 3)
  end

  defp cancel_run_with_prepared_payload_retry(initial_run, run_id, reason, attempts_left) do
    Infrastructure.run_with_busy_retry(
      fn -> maybe_preempt_cancellation_tree(run_id) end,
      :admin_control
    )

    now = Infrastructure.now_iso8601()

    prepared_cancellation =
      Infrastructure.run_with_busy_retry(
        fn -> prepare_cancellation_for_cancel_run(run_id, reason, now) end,
        :admin_control
      )

    try do
      case admin_control_transaction_with_optional_preemption(initial_run, fn ->
             cancel_run_in_transaction(run_id, reason, now, prepared_cancellation)
           end) do
        {:ok, result} ->
          result

        {:error, error} when attempts_left > 1 ->
          if stale_cancellation_preflight_error?(error) do
            cancel_run_with_prepared_payload_retry(initial_run, run_id, reason, attempts_left - 1)
          else
            unwrap_transaction_result({:error, error})
          end

        {:error, error} when is_atom(error) ->
          if stale_cancellation_preflight_error?(error) do
            raise RuntimeError, "stale cancellation plan after retries: #{error}"
          else
            unwrap_transaction_result({:error, error})
          end

        {:error, error} ->
          unwrap_transaction_result({:error, error})
      end
    after
      discard_prepared_cancel_run(prepared_cancellation)
    end
  end

  defp prepare_cancellation_for_cancel_run(run_id, reason, now) do
    case get_run(run_id) do
      %{"definitionKind" => "workflow"} = run ->
        if FailureRecovery.terminal_run_status?(run["status"]) do
          nil
        else
          %{
            kind: :workflow_cancellation,
            prepared:
              FailureRecovery.prepare_workflow_cancellation!(
                run,
                FailureRecovery.cancellation_error("Run cancelled", reason),
                reason,
                now
              )
          }
        end

      %{"definitionKind" => "service"} = run ->
        if FailureRecovery.terminal_run_status?(run["status"]) do
          nil
        else
          case get_service_run_by_id(run["id"]) do
            nil ->
              nil

            service_run ->
              %{
                kind: :service_stop,
                prepared:
                  FailureRecovery.ServiceFailure.prepare_service_stop!(
                    service_run,
                    FailureRecovery.cancellation_error("Service stopped", reason),
                    reason,
                    now
                  )
              }
          end
        end

      _ ->
        nil
    end
  end

  defp cancel_run_in_transaction(run_id, reason, now, prepared_cancellation) do
    case get_run(run_id) do
      nil ->
        nil

      %{"definitionKind" => "service"} ->
        service_run = get_service_run_by_id(run_id)

        if (is_nil(prepared_cancellation) and service_run) && service_run["status"] != "stopped" do
          Repo.rollback(:stale_cancellation_plan)
        end

        FailureRecovery.stop_service_run_instance!(
          service_run,
          FailureRecovery.cancellation_error("Service stopped", reason),
          reason,
          now,
          nil,
          prepared_service_stop_for_cancel_run!(prepared_cancellation)
        )

      run ->
        FailureRecovery.cancel_workflow_run_instance!(
          run,
          FailureRecovery.cancellation_error("Run cancelled", reason),
          reason,
          now,
          prepared_workflow_cancellation_for_cancel_run!(prepared_cancellation)
        )
    end
  end

  defp prepare_service_stop_for_admin(
         project_name,
         definition_name,
         service_key,
         error_body,
         reason,
         now
       ) do
    case get_service_run(project_name, definition_name, service_key) do
      nil ->
        nil

      service_run ->
        if service_run["status"] == "stopped" do
          nil
        else
          FailureRecovery.ServiceFailure.prepare_service_stop!(
            service_run,
            error_body,
            reason,
            now
          )
        end
    end
  end

  defp prepared_workflow_cancellation_for_cancel_run!(nil), do: nil

  defp prepared_workflow_cancellation_for_cancel_run!(%{
         kind: :workflow_cancellation,
         prepared: prepared
       }),
       do: prepared

  defp prepared_workflow_cancellation_for_cancel_run!(_prepared),
    do: Repo.rollback(:stale_cancellation_plan)

  defp prepared_service_stop_for_cancel_run!(nil), do: nil

  defp prepared_service_stop_for_cancel_run!(%{kind: :service_stop, prepared: prepared}),
    do: prepared

  defp prepared_service_stop_for_cancel_run!(_prepared),
    do: Repo.rollback(:stale_cancellation_plan)

  defp discard_prepared_cancel_run(nil), do: :ok

  defp discard_prepared_cancel_run(%{kind: :workflow_cancellation, prepared: prepared}) do
    FailureRecovery.discard_prepared_workflow_cancellation(prepared)
  end

  defp discard_prepared_cancel_run(%{kind: :service_stop, prepared: prepared}) do
    FailureRecovery.ServiceFailure.discard_prepared_service_stop(prepared)
  end

  def purge_project_runtime(project_name) do
    now = Infrastructure.now_iso8601()
    active_managed_workers = list_project_active_managed_workers(project_name)

    Enum.each(active_managed_workers, fn worker_id ->
      _ = VilanoKernel.ManagedWorker.kill_worker(worker_id, :project_runtime_purge)
    end)

    result =
      Infrastructure.transaction_with_busy_retry(
        fn ->
          case get_project(project_name) do
            nil ->
              nil

            _project ->
              run_count = count_project_runs(project_name)
              service_run_count = count_project_service_runs(project_name)
              envelope_count = count_project_service_envelopes(project_name)

              delete_project_runtime_rows!(project_name)

              %{
                "project" => project_name,
                "purgedRunCount" => run_count,
                "purgedServiceRunCount" => service_run_count,
                "purgedEnvelopeCount" => envelope_count,
                "killedManagedWorkerIds" => active_managed_workers,
                "purgedAt" => now
              }
          end
        end,
        :admin_control
      )
      |> unwrap_transaction_result()

    if result do
      EventPayloads.garbage_collect!(0)
    end

    result
  end

  def prune_runtime(opts \\ %{}), do: Prune.prune_runtime(opts)

  def list_service_runs(project_name \\ nil, active_only \\ false) do
    Infrastructure.run_with_busy_retry(
      fn ->
        {where_sql, args} =
          case {project_name, active_only} do
            {nil, false} ->
              {"where r.definition_kind = 'service'", []}

            {nil, true} ->
              {"where r.definition_kind = 'service' and r.status not in ('idle', 'stopped')", []}

            {project, false} ->
              {"where r.definition_kind = 'service' and r.project_name = ?", [project]}

            {project, true} ->
              {"where r.definition_kind = 'service' and r.project_name = ? and r.status not in ('idle', 'stopped')",
               [project]}
          end

        Repo
        |> SQL.query!(
          """
          select
            r.id,
            r.project_name,
            r.definition_kind,
            r.definition_name,
            r.status,
            r.lease_id,
            r.lease_worker_id,
            r.lease_expires_at,
            r.input_json,
            r.output_json,
            r.error_json,
            r.created_at,
            r.updated_at,
            s.service_key,
            s.key_input_json,
            s.state_json,
            s.created_at as service_created_at,
            s.updated_at as service_updated_at
          from runs r
          join service_runs s on s.run_id = r.id
          #{where_sql}
          order by r.created_at desc
          """,
          args
        )
        |> rows_to_maps()
        |> Enum.map(&service_run_from_row(&1, &1))
        |> Enum.map(&decorate_service_passivation/1)
      end,
      :public_read
    )
  end

  defdelegate resolve_spawn(lease_id, definition_name, op_key, child_run_id, input),
    to: WorkflowOps

  defdelegate resolve_child_result_wait(lease_id, child_run_id, op_key), to: WorkflowOps

  defdelegate resolve_service_send(lease_id, service_run_id, name, op_key, payload),
    to: ServiceOps

  defdelegate resolve_service_signal(lease_id, service_run_id, name, op_key, payload),
    to: ServiceOps

  def resolve_service_ask(lease_id, service_run_id, name, op_key, payload, timeout_ms \\ nil),
    do:
      ServiceOps.resolve_service_ask(lease_id, service_run_id, name, op_key, payload, timeout_ms)

  defdelegate complete_service_turn(lease_id, envelope_id, body), to: ServiceOps
  defdelegate get_service_turn_mailbox(lease_id, envelope_id), to: ServiceOps

  def defer_service_turn(lease_id, envelope_id, delay_ms, reason \\ nil),
    do: ServiceOps.defer_service_turn(lease_id, envelope_id, delay_ms, reason)

  defdelegate reject_service_turn(lease_id, envelope_id, error_body), to: ServiceOps

  def fail_service_turn(lease_id, envelope_id, error_body, retry_options \\ %{}),
    do: ServiceOps.fail_service_turn(lease_id, envelope_id, error_body, retry_options)

  defdelegate lease_next_run(worker_id), to: ActivationLifecycle
  defdelegate heartbeat_lease(lease_id, worker_id), to: ActivationLifecycle
  defdelegate lease_status(lease_id), to: ActivationLifecycle
  defdelegate complete_run_lease(lease_id, result), to: ActivationLifecycle
  defdelegate fail_run_lease(lease_id, error_body), to: ActivationLifecycle

  def resolve_step(lease_id, name, op_key),
    do: ActivationLifecycle.resolve_step(lease_id, name, op_key)

  def resolve_step(lease_id, name, op_key, timeout_ms),
    do: ActivationLifecycle.resolve_step(lease_id, name, op_key, timeout_ms)

  def resolve_step(lease_id, name, op_key, timeout_ms, retry_policy),
    do: ActivationLifecycle.resolve_step(lease_id, name, op_key, timeout_ms, retry_policy)

  defdelegate complete_step(lease_id, name, op_key, output), to: ActivationLifecycle
  defdelegate fail_step(lease_id, name, op_key, error_body), to: ActivationLifecycle

  defdelegate timeout_step(lease_id, op_key, expected_attempt, error_body),
    to: ActivationLifecycle

  defdelegate resolve_exec(lease_id, name, op_key, exec_spec), to: ActivationLifecycle
  defdelegate complete_exec(lease_id, name, op_key, body), to: ActivationLifecycle
  defdelegate fail_exec(lease_id, name, op_key, body), to: ActivationLifecycle
  defdelegate resolve_sleep_wait(lease_id, op_key, duration_ms), to: ActivationLifecycle
  defdelegate satisfy_timed_wait(run_id, op_key, expected_wake_at), to: ActivationLifecycle
  defdelegate list_waiting_timed_waits(), to: ActivationLifecycle
  defdelegate resolve_signal_wait(lease_id, name, op_key), to: ActivationLifecycle
  defdelegate resolve_run_monitor(lease_id, target_run_id, op_key), to: AgentRelationships

  def resolve_run_link(lease_id, target_run_id, op_key, propagate \\ "abnormal"),
    do: AgentRelationships.resolve_run_link(lease_id, target_run_id, op_key, propagate)

  defdelegate set_trap_exits(lease_id, enabled), to: AgentRelationships
  defdelegate resolve_exit_wait(lease_id, op_key), to: AgentRelationships

  defdelegate resolve_supervision_group(
                lease_id,
                op_key,
                strategy,
                max_restarts,
                window_ms,
                on_exhausted
              ),
              to: Supervision

  defdelegate resolve_supervised_spawn(lease_id, group_id, definition_name, member_key, input),
    to: Supervision

  defdelegate resolve_supervision_member_result_wait(lease_id, group_id, member_key, op_key),
    to: Supervision

  defdelegate get_supervision_member_status(lease_id, group_id, member_key), to: Supervision
  defdelegate list_supervision_members(lease_id, group_id), to: Supervision
  defdelegate lookup_singleton_service(lease_id, role, key_input), to: AgentTopology
  defdelegate resolve_topic_publish(lease_id, topic, op_key, payload), to: AgentTopology
  defdelegate subscribe_service_topic(lease_id, topic, signal_name), to: AgentTopology
  defdelegate unsubscribe_service_topic(lease_id, topic, signal_name), to: AgentTopology
  defdelegate send_run_signal(run_id, signal_name, payload), to: ActivationLifecycle

  def list_runs(project_name \\ nil), do: ReadModels.list_runs(project_name)
  def get_run(run_id), do: ReadModels.get_run(run_id)

  def get_run_for_inspect(run_id) do
    case get_run(run_id) do
      nil ->
        nil

      %{"definitionKind" => "service"} ->
        run_id
        |> get_service_run_by_id()
        |> Kernel.||(get_run(run_id))
        |> decorate_service_passivation()

      run ->
        run
    end
  end

  def runnable_activation_available?, do: ActivationLifecycle.runnable_activation_available?()
  def list_run_events(run_id), do: ReadModels.list_run_events(run_id)
  def list_run_steps(run_id), do: ReadModels.list_run_steps(run_id)
  def list_active_timed_steps, do: ReadModels.list_active_timed_steps()
  def list_active_leases, do: ReadModels.list_active_leases()
  def oldest_runnable_workflow_candidate, do: ReadModels.oldest_runnable_workflow_candidate()

  def oldest_runnable_service_turn_candidate,
    do: ReadModels.oldest_runnable_service_turn_candidate()

  def list_oldest_pending_runs(limit \\ 10), do: ReadModels.list_oldest_pending_runs(limit)
  def count_pending_runs_by_project, do: ReadModels.count_pending_runs_by_project()
  def list_run_execs(run_id), do: ReadModels.list_run_execs(run_id)
  def list_run_waits(run_id), do: ReadModels.list_run_waits(run_id)
  def list_run_signals(run_id), do: ReadModels.list_run_signals(run_id)
  def list_run_children(run_id), do: ReadModels.list_run_children(run_id)
  def count_runs_by_status, do: ReadModels.count_runs_by_status()
  def count_runs_by_project_and_status, do: ReadModels.count_runs_by_project_and_status()

  def list_service_envelopes(service_run_id),
    do: ReadModels.list_service_envelopes(service_run_id)

  def ensure_column!(table_name, column_name, definition),
    do: Support.ensure_column!(table_name, column_name, definition)

  defp decorate_service_passivation(nil), do: nil

  defp decorate_service_passivation(%{"definitionKind" => "service"} = run) do
    passivation =
      cond do
        run["status"] == "active" ->
          %{"state" => "active", "wakeReason" => "message"}

        run["status"] == "pending" ->
          %{"state" => "pending", "wakeReason" => "message"}

        run["status"] == "waiting" ->
          case list_run_waits(run["id"]) do
            [] ->
              %{"state" => "waiting", "wakeReason" => "unknown"}

            waits ->
              wait =
                waits
                |> Enum.filter(&(&1["status"] == "waiting"))
                |> List.first()

              %{
                "state" => "waiting",
                "wakeReason" =>
                  case wait do
                    %{"kind" => "sleep"} -> "timer"
                    %{"kind" => "retry_backoff"} -> "retry_backoff"
                    %{"kind" => "signal"} -> "signal"
                    %{"kind" => "ask_reply"} -> "ask_reply"
                    %{"kind" => "child_result"} -> "child_result"
                    %{"kind" => "supervision_member_result"} -> "supervision_member_result"
                    %{"kind" => "exit"} -> "exit"
                    _ -> "unknown"
                  end
              }
          end

        true ->
          %{"state" => "passivated", "wakeReason" => "message"}
      end

    Map.put(run, "passivation", passivation)
  end

  defp decorate_service_passivation(run), do: run

  defp maybe_preempt_active_managed_worker(nil), do: :ok

  defp maybe_preempt_active_managed_worker(run) do
    case run["leaseWorkerId"] do
      worker_id when is_binary(worker_id) ->
        _ = VilanoKernel.ManagedWorker.kill_worker(worker_id, :admin_control)
        :ok

      _ ->
        :ok
    end
  end

  defp admin_control_transaction_with_optional_preemption(run, fun) do
    result =
      try do
        Infrastructure.transaction_with_busy_retry(fun, :admin_control)
      rescue
        error ->
          if busy_exception?(error) and managed_worker_run?(run) do
            maybe_preempt_active_managed_worker(run)
            Infrastructure.transaction_with_busy_retry(fun, :admin_control)
          else
            reraise error, __STACKTRACE__
          end
      end

    maybe_preempt_active_managed_worker(run)
    result
  end

  defp maybe_preempt_cancellation_tree(run_id, visited_run_ids \\ MapSet.new()) do
    if MapSet.member?(visited_run_ids, run_id) do
      :ok
    else
      visited_run_ids = MapSet.put(visited_run_ids, run_id)

      case get_run(run_id) do
        nil ->
          :ok

        run ->
          maybe_preempt_active_managed_worker(run)

          run_id
          |> list_open_child_rows()
          |> Enum.each(fn child ->
            maybe_preempt_cancellation_tree(child["child_run_id"], visited_run_ids)
          end)

          run_id
          |> list_waiting_service_ask_ops()
          |> Enum.each(fn op ->
            maybe_preempt_cancellation_tree(op["service_run_id"], visited_run_ids)
          end)

          :ok
      end
    end
  end

  defp stale_cancellation_preflight_error?(reason) when is_atom(reason) do
    reason
    |> Atom.to_string()
    |> String.starts_with?("stale_")
  end

  defp stale_cancellation_preflight_error?(_reason), do: false

  defp managed_worker_run?(%{"leaseWorkerId" => "managed-local-" <> _rest}), do: true
  defp managed_worker_run?(_run), do: false

  defp busy_exception?(reason) when is_exception(reason) do
    reason
    |> Exception.message()
    |> String.downcase()
    |> busy_message?()
  end

  defp busy_exception?(reason) when is_binary(reason) do
    reason
    |> String.downcase()
    |> busy_message?()
  end

  defp busy_exception?(_reason), do: false

  defp busy_message?(message) do
    String.contains?(message, "database busy") or
      String.contains?(message, "database is locked") or
      String.contains?(message, "busy")
  end

  defp list_project_active_managed_workers(project_name) do
    list_active_leases()
    |> Enum.filter(fn lease ->
      lease["project"] == project_name and is_binary(lease["leaseWorkerId"])
    end)
    |> Enum.map(& &1["leaseWorkerId"])
    |> Enum.uniq()
  end

  defp count_project_runs(project_name) do
    Repo
    |> SQL.query!("select count(*) from runs where project_name = ?", [project_name])
    |> first_integer()
  end

  defp count_project_service_runs(project_name) do
    Repo
    |> SQL.query!(
      """
      select count(*)
      from service_runs
      where run_id in (select id from runs where project_name = ?)
      """,
      [project_name]
    )
    |> first_integer()
  end

  defp count_project_service_envelopes(project_name) do
    Repo
    |> SQL.query!(
      """
      select count(*)
      from service_envelopes
      where
        service_run_id in (select id from runs where project_name = ?)
        or sender_run_id in (select id from runs where project_name = ?)
      """,
      [project_name, project_name]
    )
    |> first_integer()
  end

  defp delete_project_runtime_rows!(project_name) do
    delete_project_rows!(
      """
      delete from run_exit_events
      where relationship_id in (
        select id
        from run_relationships
        where
          owner_run_id in (select id from runs where project_name = ?)
          or target_run_id in (select id from runs where project_name = ?)
      )
      """,
      [project_name, project_name]
    )

    delete_project_rows!(
      "delete from run_signals where run_id in (select id from runs where project_name = ?)",
      [project_name]
    )

    delete_project_rows!(
      """
      delete from topic_subscriptions
      where service_run_id in (select id from runs where project_name = ?)
      """,
      [project_name]
    )

    delete_project_rows!(
      """
      delete from run_topic_publishes
      where caller_run_id in (select id from runs where project_name = ?)
      """,
      [project_name]
    )

    delete_project_rows!(
      """
      delete from run_service_refs
      where
        caller_run_id in (select id from runs where project_name = ?)
        or service_run_id in (select id from runs where project_name = ?)
      """,
      [project_name, project_name]
    )

    delete_project_rows!(
      """
      delete from run_service_ops
      where
        caller_run_id in (select id from runs where project_name = ?)
        or service_run_id in (select id from runs where project_name = ?)
      """,
      [project_name, project_name]
    )

    delete_project_rows!(
      """
      delete from service_envelopes
      where
        service_run_id in (select id from runs where project_name = ?)
        or sender_run_id in (select id from runs where project_name = ?)
      """,
      [project_name, project_name]
    )

    delete_project_rows!(
      """
      delete from run_supervision_restarts
      where
        group_id in (
          select id
          from run_supervision_groups
          where owner_run_id in (select id from runs where project_name = ?)
        )
        or child_run_id in (select id from runs where project_name = ?)
      """,
      [project_name, project_name]
    )

    delete_project_rows!(
      """
      delete from run_supervision_members
      where
        group_id in (
          select id
          from run_supervision_groups
          where owner_run_id in (select id from runs where project_name = ?)
        )
        or current_child_run_id in (select id from runs where project_name = ?)
      """,
      [project_name, project_name]
    )

    delete_project_rows!(
      """
      delete from run_supervision_groups
      where owner_run_id in (select id from runs where project_name = ?)
      """,
      [project_name]
    )

    delete_project_rows!(
      """
      delete from run_children
      where
        parent_run_id in (select id from runs where project_name = ?)
        or child_run_id in (select id from runs where project_name = ?)
      """,
      [project_name, project_name]
    )

    delete_project_rows!(
      "delete from run_waits where run_id in (select id from runs where project_name = ?)",
      [project_name]
    )

    delete_project_rows!(
      "delete from run_execs where run_id in (select id from runs where project_name = ?)",
      [project_name]
    )

    delete_project_rows!(
      "delete from run_steps where run_id in (select id from runs where project_name = ?)",
      [project_name]
    )

    delete_project_rows!(
      "delete from run_event_sequences where run_id in (select id from runs where project_name = ?)",
      [project_name]
    )

    delete_project_rows!(
      "delete from run_events where run_id in (select id from runs where project_name = ?)",
      [project_name]
    )

    delete_project_rows!(
      """
      delete from run_relationships
      where
        owner_run_id in (select id from runs where project_name = ?)
        or target_run_id in (select id from runs where project_name = ?)
      """,
      [project_name, project_name]
    )

    delete_project_rows!(
      "delete from service_runs where run_id in (select id from runs where project_name = ?)",
      [project_name]
    )

    delete_project_rows!(
      "delete from runs where project_name = ?",
      [project_name]
    )
  end

  defp delete_project_rows!(query, args) do
    SQL.query!(Repo, query, args)
    :ok
  end
end
