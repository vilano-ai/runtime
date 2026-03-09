defmodule VilanoKernel.Storage.ReadModels do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def list_runs(project_name \\ nil) do
    query =
      if is_nil(project_name) do
        """
        select
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
          lease_worker_id,
          lease_expires_at,
          input_json,
          output_json,
          error_json,
          created_at,
          updated_at
        from runs
        order by created_at desc
        """
      else
        """
        select
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
          lease_worker_id,
          lease_expires_at,
          input_json,
          output_json,
          error_json,
          created_at,
          updated_at
        from runs
        where project_name = ?
        order by created_at desc
        """
      end

    args = if is_nil(project_name), do: [], else: [project_name]

    Repo
    |> SQL.query!(query, args)
    |> rows_to_maps()
    |> Enum.map(&run_from_row/1)
  end

  def get_run(run_id) do
    Repo
    |> SQL.query!(
      """
      select
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
          lease_worker_id,
        lease_expires_at,
        input_json,
        output_json,
        error_json,
        created_at,
        updated_at
      from runs
      where id = ?
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> List.first()
    |> case do
      nil -> nil
      row -> run_from_row(row)
    end
  end

  def list_run_events(run_id) do
    Repo
    |> SQL.query!(
      """
      select
        id,
        run_id,
        seq,
        event_type,
        body_json,
        created_at
      from run_events
      where run_id = ?
      order by seq asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&run_event_from_row/1)
  end

  def list_run_steps(run_id) do
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
      where run_id = ?
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&step_from_row/1)
  end

  def list_active_timed_steps do
    Repo
    |> SQL.query!(
      """
      select
        s.run_id,
        s.op_key,
        s.name,
        s.attempt,
        s.timeout_ms,
        s.updated_at,
        r.lease_id,
        r.lease_worker_id
      from run_steps s
      join runs r on r.id = s.run_id
      where
        s.status = 'running'
        and s.timeout_ms is not null
        and r.status in ('running', 'active')
        and r.lease_id is not null
      order by s.updated_at asc
      """,
      []
    )
    |> rows_to_maps()
    |> Enum.map(fn row ->
      %{
        "runId" => row["run_id"],
        "key" => row["op_key"],
        "name" => row["name"],
        "attempt" => row["attempt"],
        "timeoutMs" => row["timeout_ms"],
        "startedAt" => row["updated_at"],
        "leaseId" => row["lease_id"],
        "leaseWorkerId" => row["lease_worker_id"]
      }
    end)
  end

  def list_run_execs(run_id) do
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
      where run_id = ?
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&exec_from_row/1)
  end

  def list_run_waits(run_id) do
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
      where run_id = ?
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&wait_from_row/1)
  end

  def list_run_signals(run_id) do
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
      where run_id = ?
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&signal_from_row/1)
  end

  def list_run_children(run_id) do
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
      where parent_run_id = ?
      order by created_at asc
      """,
      [run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&child_from_row/1)
  end

  def list_service_envelopes(service_run_id) do
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
        created_at,
        updated_at
      from service_envelopes
      where service_run_id = ?
      order by created_at asc
      """,
      [service_run_id]
    )
    |> rows_to_maps()
    |> Enum.map(&service_envelope_from_row/1)
  end

  defp run_from_row(row) do
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

  defp definition_from_row(row) do
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

  defp run_event_from_row(row) do
    %{
      "id" => row["id"],
      "runId" => row["run_id"],
      "seq" => row["seq"],
      "type" => row["event_type"],
      "body" => decode_json_value(row["body_json"], %{}),
      "createdAt" => row["created_at"]
    }
  end

  defp step_from_row(row) do
    %{
      "runId" => row["run_id"],
      "key" => row["op_key"],
      "name" => row["name"],
      "status" => row["status"],
      "attempt" => row["attempt"],
      "maxAttempts" => row["max_attempts"],
      "backoffKind" => row["backoff_kind"],
      "backoffMs" => row["backoff_ms"],
      "backoffStepMs" => row["backoff_step_ms"],
      "backoffFactor" => row["backoff_factor"],
      "maxBackoffMs" => row["max_backoff_ms"],
      "backoffJitterKind" => row["backoff_jitter_kind"],
      "backoffJitterRatio" => row["backoff_jitter_ratio"],
      "retryOn" => decode_json_list(row["retry_on_json"]),
      "timeoutMs" => row["timeout_ms"],
      "output" => decode_json_value(row["output_json"], nil),
      "error" => decode_json_value(row["error_json"], nil),
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  defp exec_from_row(row) do
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

  defp wait_from_row(row) do
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

  defp signal_from_row(row) do
    %{
      "id" => row["id"],
      "runId" => row["run_id"],
      "name" => row["signal_name"],
      "payload" => decode_json_value(row["payload_json"], nil),
      "consumedAt" => row["consumed_at"],
      "createdAt" => row["created_at"]
    }
  end

  defp child_from_row(row) do
    %{
      "parentRunId" => row["parent_run_id"],
      "key" => row["op_key"],
      "childRunId" => row["child_run_id"],
      "definitionName" => row["definition_name"],
      "status" => row["status"],
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  defp service_envelope_from_row(row) do
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
      "createdAt" => row["created_at"],
      "updatedAt" => row["updated_at"]
    }
  end

  defp rows_to_maps(%{columns: columns, rows: rows}) do
    Enum.map(rows, fn row ->
      Enum.zip(columns, row) |> Map.new()
    end)
  end

  defp decode_json_list(nil), do: []
  defp decode_json_list(value) when is_binary(value), do: Jason.decode!(value)

  defp decode_json_map_keys(nil), do: []

  defp decode_json_map_keys(value) when is_binary(value) do
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

  defp decode_json_value(nil, fallback), do: fallback
  defp decode_json_value(value, _fallback) when is_binary(value), do: Jason.decode!(value)
end
