defmodule VilanoKernel.Storage.AgentKernel do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def relationship_from_row(row) do
    %{
      "id" => row["id"],
      "ownerRunId" => row["owner_run_id"],
      "key" => row["op_key"],
      "targetRunId" => row["target_run_id"],
      "kind" => row["kind"],
      "propagate" => row["propagate"],
      "status" => row["status"],
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  def supervision_group_from_row(row) do
    %{
      "id" => row["id"],
      "ownerRunId" => row["owner_run_id"],
      "key" => row["op_key"],
      "strategy" => row["strategy"],
      "maxRestarts" => row["max_restarts"],
      "windowMs" => row["window_ms"],
      "onExhausted" => row["on_exhausted"],
      "status" => row["status"],
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  def topic_subscription_from_row(nil), do: nil

  def topic_subscription_from_row(row) do
    %{
      "topic" => row["topic"],
      "signal" => row["signal_name"],
      "serviceRunId" => row["service_run_id"]
    }
  end

  def topic_publish_from_row(nil), do: nil

  def topic_publish_from_row(row) do
    %{
      "publishId" => row["publish_id"],
      "topic" => row["topic"],
      "matched" => row["matched_count"],
      "enqueued" => row["enqueued_count"],
      "rejected" => row["rejected_count"]
    }
  end

  def get_pending_exit_event(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        run_id,
        relationship_id,
        event_json,
        consumed_at,
        created_at
      from run_exit_events
      where run_id = ? and consumed_at is null
      order by created_at asc, id asc
      limit 1
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_waiting_exit_wait(run_id) do
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
      where run_id = ? and wait_kind = 'exit' and status = 'waiting'
      order by created_at asc
      limit 1
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_relationship(owner_run_id, op_key) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        owner_run_id,
        op_key,
        target_run_id,
        kind,
        propagate,
        status,
        created_at,
        updated_at
      from run_relationships
      where owner_run_id = ? and op_key = ?
      """,
      [owner_run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_relationship_by_id(relationship_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        owner_run_id,
        op_key,
        target_run_id,
        kind,
        propagate,
        status,
        created_at,
        updated_at
      from run_relationships
      where id = ?
      """,
      [relationship_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def list_active_run_relationships_for_target(target_run_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        owner_run_id,
        op_key,
        target_run_id,
        kind,
        propagate,
        status,
        created_at,
        updated_at
      from run_relationships
      where target_run_id = ? and status = 'active'
      order by created_at asc
      """,
      [target_run_id]
    )
    |> rows_to_maps()
  end

  def get_run_supervision_group(owner_run_id, op_key) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        owner_run_id,
        op_key,
        strategy,
        max_restarts,
        window_ms,
        on_exhausted,
        status,
        created_at,
        updated_at
      from run_supervision_groups
      where owner_run_id = ? and op_key = ?
      """,
      [owner_run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_supervision_group_by_id(group_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        owner_run_id,
        op_key,
        strategy,
        max_restarts,
        window_ms,
        on_exhausted,
        status,
        created_at,
        updated_at
      from run_supervision_groups
      where id = ?
      """,
      [group_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_supervision_group_for_owner(owner_run_id, group_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        owner_run_id,
        op_key,
        strategy,
        max_restarts,
        window_ms,
        on_exhausted,
        status,
        created_at,
        updated_at
      from run_supervision_groups
      where owner_run_id = ? and id = ?
      """,
      [owner_run_id, group_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_supervision_member(group_id, member_key) do
    Repo
    |> SQL.query!(
      """
      select
        group_id,
        member_key,
        definition_name,
        input_json,
        current_child_run_id,
        generation,
        status,
        created_at,
        updated_at
      from run_supervision_members
      where group_id = ? and member_key = ?
      """,
      [group_id, member_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_supervision_member_by_child(child_run_id) do
    Repo
    |> SQL.query!(
      """
      select
        group_id,
        member_key,
        definition_name,
        input_json,
        current_child_run_id,
        generation,
        status,
        created_at,
        updated_at
      from run_supervision_members
      where current_child_run_id = ?
      """,
      [child_run_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def list_run_supervision_members(group_id) do
    Repo
    |> SQL.query!(
      """
      select
        group_id,
        member_key,
        definition_name,
        input_json,
        current_child_run_id,
        generation,
        status,
        created_at,
        updated_at
      from run_supervision_members
      where group_id = ?
      order by created_at asc, member_key asc
      """,
      [group_id]
    )
    |> rows_to_maps()
  end

  def count_recent_supervision_restarts(group_id, since_at) do
    Repo
    |> SQL.query!(
      """
      select count(*)
      from run_supervision_restarts
      where group_id = ? and created_at >= ?
      """,
      [group_id, since_at]
    )
    |> first_integer()
  end

  def supervision_member_wait_name(group_id, member_key), do: group_id <> ":" <> member_key

  def supervision_member_runtime_state(nil, _get_run_fn), do: nil

  def supervision_member_runtime_state(member, get_run_fn) do
    status =
      case member["status"] do
        "restarting" ->
          "restarting"

        "completed" ->
          "completed"

        "failed" ->
          "failed"

        "exhausted" ->
          "failed"

        _ ->
          case member["current_child_run_id"] && get_run_fn.(member["current_child_run_id"]) do
            %{"status" => child_status} -> child_status
            _ -> member["status"]
          end
      end

    %{
      "groupId" => member["group_id"],
      "key" => member["member_key"],
      "definitionName" => member["definition_name"],
      "input" => Jason.decode!(member["input_json"] || "{}"),
      "currentChildRunId" => member["current_child_run_id"],
      "generation" => member["generation"],
      "status" => status,
      "createdAt" => member["created_at"],
      "updatedAt" => member["updated_at"]
    }
  end

  def run_trap_exits_value(run_id) do
    Repo
    |> SQL.query!(
      """
      select trap_exits
      from runs
      where id = ?
      """,
      [run_id]
    )
    |> case do
      %{rows: [[value]]} when value in [1, true] -> 1
      _ -> 0
    end
  end

  def get_topic_subscription(topic, service_run_id, signal_name) do
    Repo
    |> SQL.query!(
      """
      select
        topic,
        service_run_id,
        signal_name,
        created_at,
        updated_at
      from topic_subscriptions
      where topic = ? and service_run_id = ? and signal_name = ?
      """,
      [topic, service_run_id, signal_name]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def list_topic_subscription_targets(project_name, topic) do
    Repo
    |> SQL.query!(
      """
      select
        s.topic,
        s.signal_name,
        r.id,
        r.project_name,
        r.definition_kind,
        r.definition_name,
        r.project_snapshot_path,
        r.project_definitions_json,
        r.definition_file,
        r.definition_export_name,
        r.definition_runtime_kind,
        r.definition_source_language,
        r.status,
        r.lease_id,
        r.lease_worker_id,
        r.lease_expires_at,
        r.input_json,
        r.output_json,
        r.error_json,
        r.created_at,
        r.updated_at,
        sr.service_key,
        sr.key_input_json,
        sr.state_json,
        sr.created_at as service_created_at,
        sr.updated_at as service_updated_at
      from topic_subscriptions s
      join runs r on r.id = s.service_run_id
      join service_runs sr on sr.run_id = r.id
      where
        s.topic = ?
        and r.project_name = ?
        and r.definition_kind = 'service'
        and r.status != 'stopped'
      order by s.created_at asc, s.signal_name asc, r.id asc
      """,
      [topic, project_name]
    )
    |> rows_to_maps()
  end

  def get_run_topic_publish(caller_run_id, op_key) do
    Repo
    |> SQL.query!(
      """
      select
        caller_run_id,
        op_key,
        publish_id,
        topic,
        payload_json,
        matched_count,
        enqueued_count,
        rejected_count,
        created_at,
        updated_at
      from run_topic_publishes
      where caller_run_id = ? and op_key = ?
      """,
      [caller_run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def build_exit_event(target_run, relationship_kind, now) do
    base = %{
      "targetId" => target_run["id"],
      "targetKind" => target_run["definitionKind"],
      "relationship" => relationship_kind,
      "status" => target_run["status"],
      "at" => now
    }

    case target_run["status"] do
      "completed" -> Map.put(base, "output", target_run["output"])
      _ -> Map.put(base, "error", target_run["error"])
    end
  end

  def should_queue_link_exit_event?(status, propagate) do
    abnormal_terminal_status?(status) or (status == "completed" and propagate == "all")
  end

  def abnormal_terminal_status?(status), do: status in ["failed", "cancelled", "stopped"]

  defp rows_to_maps(%{columns: columns, rows: rows}) do
    Enum.map(rows, fn values -> Enum.zip(columns, values) |> Map.new() end)
  end

  defp first_integer(%{rows: [[value | _] | _]}) when is_integer(value), do: value
  defp first_integer(%{rows: [[value | _] | _]}) when is_float(value), do: trunc(value)
  defp first_integer(_result), do: 0
end
