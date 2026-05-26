defmodule VilanoKernel.Storage.FailureRecovery.Cancellation do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{Infrastructure, ServiceSupport, Support}
  alias VilanoKernel.Storage.Support.Sql, as: SqlSupport

  import Support
  import ServiceSupport

  def cancel_waiting_waits!(run_id, error_body, now) do
    waits = list_waiting_wait_rows(run_id)

    Enum.each(waits, fn wait ->
      SQL.query!(
        Repo,
        """
        update run_waits
        set
          status = 'failed',
          output_json = ?,
          updated_at = ?
        where run_id = ? and op_key = ?
        """,
        [maybe_encode_json(error_body), now, wait["run_id"], wait["op_key"]]
      )
    end)

    length(waits)
  end

  def cancel_running_steps!(run_id, error_body, now, prepared_events \\ nil) do
    steps = list_running_step_rows(run_id)
    validate_prepared_event_keys!(prepared_events, steps, "op_key")

    Enum.each(steps, fn step ->
      VilanoKernel.StepDeadlineManager.clear_step(step["run_id"], step["op_key"])

      SQL.query!(
        Repo,
        """
        update run_steps
        set
          status = 'cancelled',
          error_json = ?,
          updated_at = ?
        where run_id = ? and op_key = ?
        """,
        [maybe_encode_json(error_body), now, step["run_id"], step["op_key"]]
      )

      body = %{"name" => step["name"], "key" => step["op_key"], "error" => error_body}

      append_cancellation_event!(
        run_id,
        "StepCancelled",
        body,
        now,
        prepared_events,
        step["op_key"]
      )
    end)

    length(steps)
  end

  def cancel_running_execs!(run_id, error_body, now, prepared_events \\ nil) do
    execs = list_running_exec_rows(run_id)
    validate_prepared_event_keys!(prepared_events, execs, "op_key")

    Enum.each(execs, fn exec ->
      SQL.query!(
        Repo,
        """
        update run_execs
        set
          status = 'cancelled',
          error_json = ?,
          updated_at = ?
        where run_id = ? and op_key = ?
        """,
        [maybe_encode_json(error_body), now, exec["run_id"], exec["op_key"]]
      )

      body = %{
        "name" => exec["name"],
        "key" => exec["op_key"],
        "attempt" => exec["attempt"],
        "error" => error_body
      }

      append_cancellation_event!(
        run_id,
        "ProcessCancelled",
        body,
        now,
        prepared_events,
        exec["op_key"]
      )
    end)

    length(execs)
  end

  def cancel_outbound_service_asks!(
        caller_run_id,
        error_body,
        reason,
        now,
        prepared_cancellations \\ nil
      ) do
    ops = list_waiting_service_ask_ops(caller_run_id)
    validate_prepared_service_ask_cancellations!(prepared_cancellations, ops)

    Enum.each(ops, fn op ->
      SQL.query!(
        Repo,
        """
        update run_service_ops
        set
          status = 'failed',
          response_json = null,
          error_json = ?,
          updated_at = ?
        where caller_run_id = ? and op_key = ?
        """,
        [maybe_encode_json(error_body), now, op["caller_run_id"], op["op_key"]]
      )

      if is_binary(op["correlation_id"]) do
        cancel_service_envelope_by_correlation!(
          op["service_run_id"],
          op["correlation_id"],
          error_body,
          reason,
          now,
          prepared_service_ask_cancellation_for_op!(prepared_cancellations, op)
        )
      end
    end)

    length(ops)
  end

  def cancel_service_envelope_by_correlation!(
        service_run_id,
        correlation_id,
        error_body,
        reason,
        now,
        prepared_cancellation \\ nil
      ) do
    case get_open_service_envelope_by_correlation(service_run_id, correlation_id) do
      nil ->
        validate_missing_prepared_service_envelope_cancellation!(prepared_cancellation)

      envelope ->
        validate_prepared_service_envelope_cancellation!(
          prepared_cancellation,
          service_run_id,
          correlation_id,
          envelope
        )

        service_run = get_service_run_by_id(service_run_id)

        case {service_run, prepared_cancellation} do
          {nil, nil} ->
            :ok

          {nil, %{action: :none, service_run_present: false}} ->
            :ok

          {nil, %{}} ->
            Repo.rollback(:stale_cancellation_plan)

          {_, %{action: :skip_visited}} ->
            :ok

          {%{} = service_run, nil} ->
            VilanoKernel.Storage.FailureRecovery.ServiceFailure.fail_service_open_envelope!(
              service_run,
              envelope,
              error_body,
              reason,
              now,
              false
            )

          {%{} = service_run, %{action: :fail, prepared_failure: prepared_failure}} ->
            VilanoKernel.Storage.FailureRecovery.ServiceFailure.fail_service_open_envelope!(
              service_run,
              envelope,
              error_body,
              reason,
              now,
              false,
              prepared_failure
            )

          {%{}, %{}} ->
            Repo.rollback(:stale_cancellation_plan)
        end
    end
  end

  def prepare_outbound_service_ask_cancellations!(
        ops,
        error_body,
        reason,
        now,
        visited_run_ids
      ) do
    do_prepare_outbound_service_ask_cancellations!(
      ops,
      error_body,
      reason,
      now,
      visited_run_ids,
      %{}
    )
  end

  def discard_prepared_outbound_service_ask_cancellations(nil), do: :ok

  def discard_prepared_outbound_service_ask_cancellations(prepared_cancellations)
      when is_map(prepared_cancellations) do
    prepared_cancellations
    |> Map.values()
    |> Enum.each(&discard_prepared_service_ask_cancellation/1)
  end

  defp do_prepare_outbound_service_ask_cancellations!(
         [],
         _error_body,
         _reason,
         _now,
         _visited_run_ids,
         acc
       ),
       do: acc

  defp do_prepare_outbound_service_ask_cancellations!(
         [op | rest],
         error_body,
         reason,
         now,
         visited_run_ids,
         acc
       ) do
    try do
      prepared =
        if is_binary(op["correlation_id"]) do
          prepare_service_envelope_cancellation!(
            op,
            error_body,
            reason,
            now,
            visited_run_ids
          )
        else
          %{action: :none, correlation_id: nil, envelope_id: nil}
        end

      do_prepare_outbound_service_ask_cancellations!(
        rest,
        error_body,
        reason,
        now,
        visited_run_ids,
        Map.put(acc, op["op_key"], prepared)
      )
    rescue
      error ->
        discard_prepared_outbound_service_ask_cancellations(acc)
        reraise error, __STACKTRACE__
    end
  end

  defp prepare_service_envelope_cancellation!(op, error_body, reason, now, visited_run_ids) do
    case get_open_service_envelope_by_correlation(op["service_run_id"], op["correlation_id"]) do
      nil ->
        %{
          action: :none,
          service_run_id: op["service_run_id"],
          correlation_id: op["correlation_id"],
          envelope_id: nil
        }

      envelope ->
        service_run = get_service_run_by_id(op["service_run_id"])

        cond do
          is_nil(service_run) ->
            %{
              action: :none,
              service_run_id: op["service_run_id"],
              correlation_id: op["correlation_id"],
              envelope_id: envelope["id"],
              service_run_present: false
            }

          MapSet.member?(visited_run_ids, service_run["id"]) ->
            %{
              action: :skip_visited,
              service_run_id: op["service_run_id"],
              correlation_id: op["correlation_id"],
              envelope_id: envelope["id"]
            }

          true ->
            %{
              action: :fail,
              service_run_id: op["service_run_id"],
              correlation_id: op["correlation_id"],
              envelope_id: envelope["id"],
              prepared_failure:
                VilanoKernel.Storage.FailureRecovery.ServiceFailure.prepare_service_open_envelope_failure!(
                  service_run,
                  envelope,
                  error_body,
                  reason,
                  now,
                  false,
                  MapSet.put(visited_run_ids, service_run["id"])
                )
            }
        end
    end
  end

  def cancel_child_runs_for_parent!(
        parent_run_id,
        error_body,
        reason,
        now,
        prepared_child_cancellations \\ nil
      ) do
    children = list_open_child_rows(parent_run_id)

    Enum.each(children, fn child ->
      case VilanoKernel.Storage.get_run(child["child_run_id"]) do
        nil ->
          :ok

        child_run ->
          prepared_child_cancellation =
            prepared_child_cancellation_for_run!(prepared_child_cancellations, child_run)

          _ =
            VilanoKernel.Storage.FailureRecovery.WorkflowFailure.cancel_workflow_run_instance!(
              child_run,
              error_body,
              reason,
              now,
              prepared_child_cancellation
            )
      end
    end)

    length(children)
  end

  def workflow_cancellation_snapshot(run_id) do
    Infrastructure.run_with_busy_retry(
      fn ->
        running_steps = list_running_step_rows(run_id)
        running_execs = list_running_exec_rows(run_id)
        open_children = list_open_child_rows(run_id)
        waiting_service_ask_ops = list_waiting_service_ask_ops(run_id)

        %{
          "cancelledWaitCount" => length(list_waiting_wait_rows(run_id)),
          "cancelledChildRunCount" => length(open_children),
          "cancelledServiceAskCount" => length(waiting_service_ask_ops),
          "runningSteps" => running_steps,
          "runningExecs" => running_execs,
          "openChildren" => open_children,
          "waitingServiceAskOps" => waiting_service_ask_ops
        }
      end,
      :public_read
    )
  end

  defp discard_prepared_service_ask_cancellation(%{action: :fail} = prepared) do
    VilanoKernel.Storage.FailureRecovery.ServiceFailure.discard_prepared_service_open_envelope_failure(
      prepared.prepared_failure
    )
  end

  defp discard_prepared_service_ask_cancellation(_prepared), do: :ok

  defp validate_prepared_service_ask_cancellations!(nil, _ops), do: :ok

  defp validate_prepared_service_ask_cancellations!(prepared_cancellations, ops) do
    prepared_keys =
      prepared_cancellations
      |> Map.keys()
      |> Enum.sort()

    op_keys =
      ops
      |> Enum.map(& &1["op_key"])
      |> Enum.sort()

    if prepared_keys == op_keys do
      :ok
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_service_ask_cancellation_for_op!(nil, _op), do: nil

  defp prepared_service_ask_cancellation_for_op!(prepared_cancellations, op) do
    case Map.fetch(prepared_cancellations, op["op_key"]) do
      {:ok, prepared} -> prepared
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp validate_missing_prepared_service_envelope_cancellation!(nil), do: :ok

  defp validate_missing_prepared_service_envelope_cancellation!(%{
         action: :none,
         envelope_id: nil
       }),
       do: :ok

  defp validate_missing_prepared_service_envelope_cancellation!(_prepared),
    do: Repo.rollback(:stale_cancellation_plan)

  defp validate_prepared_service_envelope_cancellation!(
         nil,
         _service_run_id,
         _correlation_id,
         _envelope
       ),
       do: :ok

  defp validate_prepared_service_envelope_cancellation!(
         %{
           service_run_id: service_run_id,
           correlation_id: correlation_id,
           envelope_id: envelope_id
         },
         service_run_id,
         correlation_id,
         %{"id" => envelope_id}
       ),
       do: :ok

  defp validate_prepared_service_envelope_cancellation!(
         _prepared,
         _service_run_id,
         _correlation_id,
         _envelope
       ),
       do: Repo.rollback(:stale_cancellation_plan)

  defp append_cancellation_event!(run_id, event_type, body, now, nil, _op_key) do
    append_event!(run_id, event_type, body, now)
  end

  defp append_cancellation_event!(run_id, event_type, _body, now, prepared_events, op_key) do
    case Map.fetch(prepared_events, op_key) do
      {:ok, storage} -> SqlSupport.append_prepared_event!(run_id, event_type, storage, now)
      :error -> Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp validate_prepared_event_keys!(nil, _rows, _key), do: :ok

  defp validate_prepared_event_keys!(prepared_events, rows, key) do
    prepared_keys =
      prepared_events
      |> Map.keys()
      |> Enum.sort()

    row_keys =
      rows
      |> Enum.map(& &1[key])
      |> Enum.sort()

    if prepared_keys == row_keys do
      :ok
    else
      Repo.rollback(:stale_cancellation_plan)
    end
  end

  defp prepared_child_cancellation_for_run!(nil, _child_run), do: nil

  defp prepared_child_cancellation_for_run!(prepared_child_cancellations, child_run) do
    if VilanoKernel.Storage.FailureRecovery.terminal_run_status?(child_run["status"]) do
      nil
    else
      case Map.fetch(prepared_child_cancellations, child_run["id"]) do
        {:ok, prepared} -> prepared
        :error -> Repo.rollback(:stale_cancellation_plan)
      end
    end
  end
end
