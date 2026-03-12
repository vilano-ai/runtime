defmodule VilanoKernel.Storage.ServiceSupport do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.Infrastructure

  import VilanoKernel.Storage.Support

  def list_open_service_envelopes(service_run_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        service_run_id,
        kind,
        name,
        attempt,
        payload_json,
        correlation_id,
        sender_run_id,
        status,
        reply_json,
        error_json,
        wake_at,
        created_at,
        updated_at
      from service_envelopes
      where service_run_id = ? and status in ('queued', 'processing')
      order by created_at asc
      """,
      [service_run_id]
    )
    |> rows_to_maps()
  end

  def list_waiting_wait_rows(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        run_id,
        op_key,
        wait_kind,
        wait_name,
        status,
        wake_at,
        output_json,
        created_at,
        updated_at
      from run_waits
      where run_id = ? and status = 'waiting'
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
  end

  def list_running_step_rows(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        run_id,
        op_key,
        name,
        status,
        output_json,
        created_at,
        updated_at
      from run_steps
      where run_id = ? and status = 'running'
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
  end

  def list_running_exec_rows(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        run_id,
        op_key,
        name,
        status,
        cmd,
        args_json,
        cwd,
        env_json,
        timeout_ms,
        attempt,
        exit_code,
        signal_code,
        stdout_ref,
        stderr_ref,
        artifacts_json,
        output_json,
        error_json,
        created_at,
        updated_at
      from run_execs
      where run_id = ? and status = 'running'
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
  end

  def list_waiting_service_ask_ops(caller_run_id) do
    Repo
    |> SQL.query!(
      """
      select
        caller_run_id,
        op_key,
        service_run_id,
        op_kind,
        message_name,
        correlation_id,
        status,
        payload_json,
        response_json,
        error_json,
        created_at,
        updated_at
      from run_service_ops
      where caller_run_id = ? and op_kind = 'ask' and status = 'waiting'
      order by created_at asc
      """,
      [caller_run_id]
    )
    |> rows_to_maps()
  end

  def list_open_child_rows(parent_run_id) do
    Repo
    |> SQL.query!(
      """
      select
        parent_run_id,
        op_key,
        child_run_id,
        definition_name,
        status,
        created_at,
        updated_at
      from run_children
      where parent_run_id = ? and status not in ('completed', 'failed', 'cancelled')
      order by created_at asc
      """,
      [parent_run_id]
    )
    |> rows_to_maps()
  end

  def get_open_service_envelope_by_correlation(service_run_id, correlation_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        service_run_id,
        kind,
        name,
        attempt,
        payload_json,
        correlation_id,
        sender_run_id,
        status,
        reply_json,
        error_json,
        wake_at,
        created_at,
        updated_at
      from service_envelopes
      where
        service_run_id = ?
        and correlation_id = ?
        and status in ('queued', 'processing')
      order by
        case when status = 'processing' then 0 else 1 end asc,
        created_at asc
      limit 1
      """,
      [service_run_id, correlation_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def service_has_ready_queued_envelopes?(service_run_id) do
    now = Infrastructure.now_iso8601()

    Repo
    |> SQL.query!(
      """
      select count(*)
      from service_envelopes
      where
        service_run_id = ?
        and status = 'queued'
        and (wake_at is null or wake_at <= ?)
      """,
      [service_run_id, now]
    )
    |> first_integer()
    |> Kernel.>(0)
  end

  def queued_mailbox_summary(service_run_id, now) do
    Repo
    |> SQL.query!(
      """
      select
        count(*) as total,
        sum(case when wake_at is null or wake_at <= ? then 1 else 0 end) as ready,
        sum(case when wake_at is not null and wake_at > ? then 1 else 0 end) as deferred,
        sum(case when kind = 'ask' then 1 else 0 end) as asks,
        sum(case when kind = 'send' then 1 else 0 end) as sends,
        sum(case when kind = 'signal' then 1 else 0 end) as signals,
        min(created_at) as oldest_at,
        min(case when wake_at is not null and wake_at > ? then wake_at end) as next_wake_at
      from service_envelopes
      where service_run_id = ? and status = 'queued'
      """,
      [now, now, now, service_run_id]
    )
    |> rows_to_maps()
    |> List.first()
    |> then(fn row ->
      %{
        "total" => row["total"] || 0,
        "ready" => row["ready"] || 0,
        "deferred" => row["deferred"] || 0,
        "asks" => row["asks"] || 0,
        "sends" => row["sends"] || 0,
        "signals" => row["signals"] || 0,
        "oldestAt" => row["oldest_at"],
        "nextWakeAt" => row["next_wake_at"]
      }
    end)
  end

  def passivation_wake_kind("sleep"), do: "timer"
  def passivation_wake_kind("retry_backoff"), do: "timer"
  def passivation_wake_kind(kind) when is_binary(kind), do: kind
  def passivation_wake_kind(_kind), do: "durable_wait"

  def earliest_wake_at(values) do
    values
    |> Enum.filter(&is_binary/1)
    |> Enum.sort()
    |> List.first()
  end

  def service_mailbox_config(service_run) do
    definition =
      project_definitions_for_run(service_run)
      |> Map.get("services", [])
      |> Enum.find(&(&1["name"] == service_run["definitionName"]))

    mailbox = Map.get(definition || %{}, "mailbox") || %{}
    max_queued = Map.get(mailbox, "maxQueued")

    %{
      "maxQueued" => if(is_integer(max_queued) and max_queued > 0, do: max_queued, else: nil),
      "overload" =>
        case Map.get(mailbox, "overload") do
          "reject_new" -> "reject_new"
          _ when is_integer(max_queued) and max_queued > 0 -> "reject_new"
          _ -> nil
        end
    }
  end
end
