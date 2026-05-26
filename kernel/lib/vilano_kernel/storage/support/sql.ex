defmodule VilanoKernel.Storage.Support.Sql do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.EventPayloads
  alias VilanoKernel.Storage.Support.Rows

  def list_service_runs_by_definition(project_name, definition_name) do
    Repo
    |> SQL.query!(
      """
      select
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
        s.service_key,
        s.key_input_json,
        s.state_json,
        s.created_at as service_created_at,
        s.updated_at as service_updated_at
      from runs r
      join service_runs s on s.run_id = r.id
      where
        r.project_name = ?
        and r.definition_kind = 'service'
        and r.definition_name = ?
        and r.status != 'stopped'
      order by s.updated_at desc, r.updated_at desc, r.id desc
      """,
      [project_name, definition_name]
    )
    |> rows_to_maps()
    |> Enum.map(&Rows.service_run_from_row(&1, &1))
  end

  def rows_to_maps(%{columns: columns, rows: rows}) do
    Enum.map(rows, fn row ->
      Enum.zip(columns, row) |> Map.new()
    end)
  end

  def write_changes!(query, params) do
    SQL.query!(Repo, query, params)
    SQL.query!(Repo, "select changes()", []) |> first_integer()
  end

  def first_integer(%{rows: [[value]]}) when is_integer(value), do: value
  def first_integer(_), do: 0

  def ensure_column!(table_name, column_name, definition) do
    existing_columns =
      Repo
      |> SQL.query!("pragma table_info(#{table_name})", [])
      |> rows_to_maps()
      |> Enum.map(& &1["name"])

    unless column_name in existing_columns do
      SQL.query!(Repo, "alter table #{table_name} add column #{column_name} #{definition}", [])
    end
  end

  def get_run_exec(run_id, op_key) do
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
      where run_id = ? and op_key = ?
      """,
      [run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_step_row(run_id, op_key) do
    Repo
    |> SQL.query!(
      """
      select
        run_id,
        op_key,
        name,
        status,
        attempt,
        max_attempts,
        backoff_kind,
        backoff_ms,
        backoff_step_ms,
        backoff_factor,
        max_backoff_ms,
        backoff_jitter_kind,
        backoff_jitter_ratio,
        retry_on_json,
        timeout_ms,
        output_json,
        error_json,
        created_at,
        updated_at
      from run_steps
      where run_id = ? and op_key = ?
      """,
      [run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_wait(run_id, op_key) do
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
      where run_id = ? and op_key = ?
      """,
      [run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_pending_signal(run_id, signal_name) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        run_id,
        signal_name,
        payload_json,
        consumed_at,
        created_at
      from run_signals
      where run_id = ? and signal_name = ? and consumed_at is null
      order by created_at asc
      limit 1
      """,
      [run_id, signal_name]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_child(parent_run_id, op_key) do
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
      where parent_run_id = ? and op_key = ?
      """,
      [parent_run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_child_by_child(parent_run_id, child_run_id) do
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
      where parent_run_id = ? and child_run_id = ?
      """,
      [parent_run_id, child_run_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_service_ref(caller_run_id, service_run_id) do
    Repo
    |> SQL.query!(
      """
      select
        caller_run_id,
        service_run_id,
        created_at
      from run_service_refs
      where caller_run_id = ? and service_run_id = ?
      """,
      [caller_run_id, service_run_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def related_run_visible?(owner_run_id, target_run_id) do
    not is_nil(get_run_child_by_child(owner_run_id, target_run_id)) or
      not is_nil(get_run_service_ref(owner_run_id, target_run_id))
  end

  def record_service_ref!(nil, _service_run_id, _now), do: :ok

  def record_service_ref!(caller_run_id, service_run_id, now) do
    SQL.query!(
      Repo,
      """
      insert or ignore into run_service_refs (
        caller_run_id,
        service_run_id,
        created_at
      ) values (?, ?, ?)
      """,
      [caller_run_id, service_run_id, now]
    )

    :ok
  end

  def persist_failed_service_op!(
        caller_run_id,
        op_key,
        service_run_id,
        op_kind,
        message_name,
        correlation_id,
        payload,
        error,
        now
      ) do
    SQL.query!(
      Repo,
      """
      insert into run_service_ops (
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
      ) values (?, ?, ?, ?, ?, ?, 'failed', ?, null, ?, ?, ?)
      """,
      [
        caller_run_id,
        op_key,
        service_run_id,
        op_kind,
        message_name,
        correlation_id,
        Jason.encode!(payload),
        Rows.maybe_encode_json(error),
        now,
        now
      ]
    )
  end

  def related_run?(caller_run_id, target_run_id) do
    caller_run_id == target_run_id or
      not is_nil(get_run_child_by_child(caller_run_id, target_run_id)) or
      not is_nil(get_run_service_ref(caller_run_id, target_run_id))
  end

  def get_service_run(project_name, definition_name, service_key) do
    query_service_run(
      """
      select
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
        s.service_key,
        s.key_input_json,
        s.state_json,
        s.created_at as service_created_at,
        s.updated_at as service_updated_at
      from runs r
      join service_runs s on s.run_id = r.id
      where
        r.project_name = ?
        and r.definition_kind = 'service'
        and r.definition_name = ?
        and s.service_key = ?
      """,
      [project_name, definition_name, service_key]
    )
  end

  def get_service_run_by_id(run_id) do
    query_service_run(
      """
      select
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
        s.service_key,
        s.key_input_json,
        s.state_json,
        s.created_at as service_created_at,
        s.updated_at as service_updated_at
      from runs r
      join service_runs s on s.run_id = r.id
      where r.id = ?
      """,
      [run_id]
    )
  end

  def query_service_run(sql, args) do
    Repo
    |> SQL.query!(sql, args)
    |> rows_to_maps()
    |> List.first()
    |> case do
      nil -> nil
      row -> Rows.service_run_from_row(row, row)
    end
  end

  def get_service_envelope(envelope_id) do
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
      where id = ?
      """,
      [envelope_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_processing_service_envelope_for_run(run_id) do
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
      where service_run_id = ? and status = 'processing'
      order by updated_at desc, created_at desc
      limit 1
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def get_run_service_op(caller_run_id, op_key) do
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
      where caller_run_id = ? and op_key = ?
      """,
      [caller_run_id, op_key]
    )
    |> rows_to_maps()
    |> List.first()
  end

  def append_event!(run_id, event_type, body, created_at) do
    with_write_transaction!(fn ->
      event_id = "evt_" <> Ecto.UUID.generate()
      next_seq = reserve_next_event_seq!(run_id)
      storage = EventPayloads.body_for_storage!(body)

      result =
        insert_run_event!(event_id, run_id, next_seq, event_type, storage.body_json, created_at)

      EventPayloads.insert_payload_ref!(event_id, run_id, storage.payload_ref, created_at)
      result
    end)
  end

  defp with_write_transaction!(fun) do
    if Repo.in_transaction?() do
      fun.()
    else
      case Repo.transaction(fun, mode: :immediate) do
        {:ok, result} -> result
        {:error, reason} -> raise inspect(reason)
      end
    end
  end

  defp insert_run_event!(event_id, run_id, next_seq, event_type, body_json, created_at) do
    SQL.query!(
      Repo,
      """
      insert into run_events (
        id,
        run_id,
        seq,
        event_type,
        body_json,
        created_at
      ) values (?, ?, ?, ?, ?, ?)
      """,
      [
        event_id,
        run_id,
        next_seq,
        event_type,
        body_json,
        created_at
      ]
    )
  end

  def reserve_next_event_seq!(run_id) do
    Repo
    |> SQL.query!(
      """
      insert into run_event_sequences (run_id, next_seq)
      values (?, 2)
      on conflict(run_id) do update set next_seq = run_event_sequences.next_seq + 1
      returning next_seq - 1
      """,
      [run_id]
    )
    |> first_integer()
  end

  def insert_workflow_run!(run_id, project, definition, input, now) do
    input_json = Jason.encode!(input || %{})
    project_name = Map.fetch!(project, "name")
    definition_name = Map.fetch!(definition, "name")
    project_snapshot_path = Map.get(project, "snapshotPath") || Map.fetch!(project, "path")
    project_definitions_json = Jason.encode!(Map.fetch!(project, "definitions"))

    SQL.query!(
      Repo,
      """
      insert into runs (
        id,
        project_name,
        definition_kind,
        definition_name,
        project_snapshot_path,
        project_definitions_json,
        definition_file,
        definition_export_name,
        definition_runtime_kind,
        definition_source_language,
        status,
        lease_id,
        lease_auth_token,
        lease_worker_id,
        lease_expires_at,
        input_json,
        output_json,
        error_json,
        created_at,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      """,
      [
        run_id,
        project_name,
        "workflow",
        definition_name,
        project_snapshot_path,
        project_definitions_json,
        Map.fetch!(definition, "file"),
        Map.fetch!(definition, "exportName"),
        Map.fetch!(definition, "runtimeKind"),
        Map.fetch!(definition, "sourceLanguage"),
        "pending",
        nil,
        nil,
        nil,
        nil,
        input_json,
        nil,
        nil,
        now,
        now
      ]
    )

    append_event!(
      run_id,
      "RunStarted",
      %{
        project: project_name,
        definitionKind: "workflow",
        definitionName: definition_name,
        definition: definition,
        input: input || %{}
      },
      now
    )
  end
end
