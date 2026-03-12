defmodule VilanoKernel.Storage.Support do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def run_from_row(row) do
    %{
      "id" => row["id"],
      "project" => row["project_name"],
      "definitionKind" => row["definition_kind"],
      "definitionName" => row["definition_name"],
      "projectSnapshotPath" => row["project_snapshot_path"],
      "projectDefinitions" => decode_json_value(row["project_definitions_json"], nil),
      "definition" => definition_from_row(row),
      "status" => row["status"],
      "leaseId" => row["lease_id"],
      "leaseWorkerId" => row["lease_worker_id"],
      "leaseExpiresAt" => row["lease_expires_at"],
      "input" => decode_json_value(row["input_json"], %{}),
      "output" => decode_json_value(row["output_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  def definition_from_row(row) do
    if row["definition_file"] do
      %{
        "kind" => row["definition_kind"],
        "name" => row["definition_name"],
        "file" => row["definition_file"],
        "exportName" => row["definition_export_name"],
        "runtimeKind" => row["definition_runtime_kind"],
        "sourceLanguage" => row["definition_source_language"]
      }
    else
      nil
    end
  end

  def exec_from_row(row) do
    %{
      "runId" => row["run_id"],
      "key" => row["op_key"],
      "name" => row["name"],
      "status" => row["status"],
      "cmd" => row["cmd"],
      "args" => decode_json_list(row["args_json"]),
      "cwd" => row["cwd"],
      "env" => nil,
      "envKeys" => decode_json_map_keys(row["env_json"]),
      "timeoutMs" => row["timeout_ms"],
      "attempt" => row["attempt"],
      "exitCode" => row["exit_code"],
      "signalCode" => row["signal_code"],
      "stdoutRef" => row["stdout_ref"],
      "stderrRef" => row["stderr_ref"],
      "artifacts" => decode_json_list(row["artifacts_json"]),
      "output" => decode_json_value(row["output_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  def wait_from_row(row) do
    %{
      "runId" => row["run_id"],
      "key" => row["op_key"],
      "kind" => row["wait_kind"],
      "name" => row["wait_name"],
      "status" => row["status"],
      "wakeAt" => row["wake_at"],
      "output" => decode_json_value(row["output_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  def service_run_from_row(run_row, service_row) do
    run =
      run_from_row(run_row)
      |> Map.put("serviceKey", service_row["service_key"])
      |> Map.put("keyInput", decode_json_value(service_row["key_input_json"], %{}))
      |> Map.put("state", decode_json_value(service_row["state_json"], nil))

    run
  end

  def project_record_for_run(run) do
    %{
      "name" => run["project"],
      "path" => run["projectSnapshotPath"] || run["project"],
      "snapshotPath" => run["projectSnapshotPath"],
      "definitions" => project_definitions_for_run(run)
    }
  end

  def project_definitions_for_run(run) do
    run["projectDefinitions"] || %{"workflows" => [], "services" => []}
  end

  def find_singleton_service_definition(project_definitions, role) do
    project_definitions
    |> Map.get("services", [])
    |> Enum.find(&(get_in(&1, ["discovery", "singletonRole"]) == role))
  end

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
    |> Enum.map(&service_run_from_row(&1, &1))
  end


  def definition_from_project_definitions!(definitions, kind, definition_name) do
    bucket =
      case kind do
        "workflow" -> Map.get(definitions, "workflows", [])
        "service" -> Map.get(definitions, "services", [])
      end

    Enum.find(bucket, &(&1["name"] == definition_name)) ||
      raise "Unknown #{kind} definition '#{definition_name}' in stored project snapshot"
  end

  def service_envelope_from_row(row) do
    %{
      "id" => row["id"],
      "serviceRunId" => row["service_run_id"],
      "kind" => row["kind"],
      "name" => row["name"],
      "attempt" => row["attempt"],
      "payload" => decode_json_value(row["payload_json"], nil),
      "correlationId" => row["correlation_id"],
      "senderRunId" => row["sender_run_id"],
      "status" => row["status"],
      "reply" => decode_json_value(row["reply_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "wakeAt" => row["wake_at"],
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  def mailbox_envelope_from_row(row) do
    %{
      "id" => row["id"],
      "kind" => row["kind"],
      "name" => row["name"],
      "attempt" => row["attempt"],
      "correlationId" => row["correlation_id"],
      "senderRunId" => row["sender_run_id"],
      "createdAt" => row["created_at"],
      "wakeAt" => row["wake_at"]
    }
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

  def wait_deadline(_now, nil), do: nil

  def wait_deadline(now, timeout_ms) when is_integer(timeout_ms) and timeout_ms > 0 do
    shift_milliseconds(now, timeout_ms)
  end

  def wait_deadline(_now, _timeout_ms), do: nil

  def decode_json_list(nil), do: []
  def decode_json_list(value) when is_binary(value), do: Jason.decode!(value)

  def decode_json_map_keys(nil), do: []

  def decode_json_map_keys(value) when is_binary(value) do
    case Jason.decode!(value) do
      decoded when is_map(decoded) ->
        decoded
        |> Map.keys()
        |> Enum.sort()

      decoded when is_list(decoded) ->
        decoded
        |> Enum.filter(&is_binary/1)
        |> Enum.sort()

      _ ->
        []
    end
  end

  def decode_json_value(nil, fallback), do: fallback
  def decode_json_value(value, _fallback) when is_binary(value), do: Jason.decode!(value)

  def maybe_encode_json(nil), do: nil
  def maybe_encode_json(value), do: Jason.encode!(value)

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
        maybe_encode_json(error),
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

  def deterministic_service_run_id(project_name, definition_name, service_key) do
    digest =
      :crypto.hash(:sha256, "#{project_name}:#{definition_name}:#{service_key}")
      |> Base.encode16(case: :lower)
      |> binary_part(0, 32)

    "run_" <> digest
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
      row -> service_run_from_row(row, row)
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
    next_seq = reserve_next_event_seq!(run_id)

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
        "evt_" <> Ecto.UUID.generate(),
        run_id,
        next_seq,
        event_type,
        Jason.encode!(body),
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

  def shift_seconds(iso8601, seconds) do
    {:ok, datetime, _offset} = DateTime.from_iso8601(iso8601)
    datetime |> DateTime.add(seconds, :second) |> DateTime.to_iso8601()
  end

  def shift_milliseconds(iso8601, milliseconds) do
    {:ok, datetime, _offset} = DateTime.from_iso8601(iso8601)
    datetime |> DateTime.add(milliseconds, :millisecond) |> DateTime.to_iso8601()
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
