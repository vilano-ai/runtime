defmodule VilanoKernel.Storage.FailureRecovery.Cancellation do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  alias VilanoKernel.Storage.{ServiceSupport, Support}

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

  def cancel_running_steps!(run_id, error_body, now) do
    steps = list_running_step_rows(run_id)

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

      append_event!(
        run_id,
        "StepCancelled",
        %{
          "name" => step["name"],
          "key" => step["op_key"],
          "error" => error_body
        },
        now
      )
    end)

    length(steps)
  end

  def cancel_running_execs!(run_id, error_body, now) do
    execs = list_running_exec_rows(run_id)

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

      append_event!(
        run_id,
        "ProcessCancelled",
        %{
          "name" => exec["name"],
          "key" => exec["op_key"],
          "attempt" => exec["attempt"],
          "error" => error_body
        },
        now
      )
    end)

    length(execs)
  end

  def cancel_outbound_service_asks!(caller_run_id, error_body, reason, now) do
    ops = list_waiting_service_ask_ops(caller_run_id)

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
          now
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
        now
      ) do
    case get_open_service_envelope_by_correlation(service_run_id, correlation_id) do
      nil ->
        :ok

      envelope ->
        service_run = get_service_run_by_id(service_run_id)

        if service_run do
          VilanoKernel.Storage.FailureRecovery.ServiceFailure.fail_service_open_envelope!(
            service_run,
            envelope,
            error_body,
            reason,
            now,
            false
          )
        end
    end
  end

  def cancel_child_runs_for_parent!(parent_run_id, error_body, reason, now) do
    children = list_open_child_rows(parent_run_id)

    Enum.each(children, fn child ->
      case VilanoKernel.Storage.get_run(child["child_run_id"]) do
        nil ->
          :ok

        child_run ->
          _ =
            VilanoKernel.Storage.FailureRecovery.WorkflowFailure.cancel_workflow_run_instance!(
              child_run,
              error_body,
              reason,
              now
            )
      end
    end)

    length(children)
  end
end
