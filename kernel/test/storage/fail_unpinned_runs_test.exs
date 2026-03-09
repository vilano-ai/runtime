defmodule VilanoKernel.Storage.FailUnpinnedRunsTest do
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.Migrations.FailUnpinnedRuns

  test "marks unpinned workflow and service runs terminal" do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    workflow_id = "run_" <> Ecto.UUID.generate()
    service_id = "run_" <> Ecto.UUID.generate()
    envelope_id = "env_" <> Ecto.UUID.generate()
    caller_run_id = "run_" <> Ecto.UUID.generate()

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
      ) values (?, 'demo', 'workflow', 'legacyWorkflow', null, null, null, null, null, null, 'waiting', null, null, null, null, '{}', null, null, ?, ?)
      """,
      [workflow_id, now, now]
    )

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
      ) values (?, 'demo', 'service', 'legacyService', null, null, null, null, null, null, 'idle', null, null, null, null, '{}', null, null, ?, ?)
      """,
      [service_id, now, now]
    )

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
      ) values (?, 'demo', 'workflow', 'pinnedCaller', '/tmp/project', '{}', 'src/defs.ts', 'pinnedCaller', 'javascript', 'typescript', 'waiting', null, null, null, null, '{}', null, null, ?, ?)
      """,
      [caller_run_id, now, now]
    )

    SQL.query!(
      Repo,
      """
      insert into service_envelopes (
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
      ) values (?, ?, 'ask', 'legacy', 1, '{}', 'corr_legacy', null, 'queued', null, null, ?, ?)
      """,
      [envelope_id, service_id, now, now]
    )

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
      ) values (?, 'ask:legacy', ?, 'ask', 'legacy', 'corr_legacy', 'waiting', '{}', null, null, ?, ?)
      """,
      [caller_run_id, service_id, now, now]
    )

    SQL.query!(
      Repo,
      """
      insert into run_waits (
        run_id,
        op_key,
        wait_kind,
        wait_name,
        status,
        wake_at,
        output_json,
        created_at,
        updated_at
      ) values (?, 'legacy-wait', 'signal', 'legacy', 'waiting', null, null, ?, ?)
      """,
      [workflow_id, now, now]
    )

    SQL.query!(
      Repo,
      """
      insert into run_waits (
        run_id,
        op_key,
        wait_kind,
        wait_name,
        status,
        wake_at,
        output_json,
        created_at,
        updated_at
      ) values (?, 'ask-reply', 'ask_reply', 'corr_legacy', 'waiting', null, null, ?, ?)
      """,
      [caller_run_id, now, now]
    )

    try do
      FailUnpinnedRuns.up()

      workflow =
        SQL.query!(Repo, "select status, error_json from runs where id = ?", [workflow_id])
        |> row_map()

      service =
        SQL.query!(Repo, "select status, error_json from runs where id = ?", [service_id])
        |> row_map()

      envelope =
        SQL.query!(Repo, "select status, error_json from service_envelopes where id = ?", [envelope_id])
        |> row_map()

      wait =
        SQL.query!(Repo, "select status, output_json from run_waits where run_id = ? and op_key = 'legacy-wait'", [
          workflow_id
        ])
        |> row_map()

      ask_wait =
        SQL.query!(Repo, "select status, output_json from run_waits where run_id = ? and op_key = 'ask-reply'", [
          caller_run_id
        ])
        |> row_map()

      ask_op =
        SQL.query!(Repo, "select status, error_json from run_service_ops where caller_run_id = ?", [caller_run_id])
        |> row_map()

      caller_run =
        SQL.query!(Repo, "select status from runs where id = ?", [caller_run_id])
        |> row_map()

      assert workflow["status"] == "failed"
      assert service["status"] == "stopped"
      assert envelope["status"] == "failed"
      assert wait["status"] == "failed"
      assert ask_wait["status"] == "failed"
      assert ask_op["status"] == "failed"
      assert caller_run["status"] == "pending"
      assert Jason.decode!(workflow["error_json"])["reason"] == "missing_pinned_definition"
      assert Jason.decode!(service["error_json"])["reason"] == "missing_pinned_definition"
      assert Jason.decode!(ask_op["error_json"])["reason"] == "missing_pinned_definition"
    after
      SQL.query!(Repo, "delete from run_waits where run_id in (?, ?, ?)", [workflow_id, service_id, caller_run_id])
      SQL.query!(Repo, "delete from run_service_ops where caller_run_id = ?", [caller_run_id])
      SQL.query!(Repo, "delete from service_envelopes where service_run_id = ?", [service_id])
      SQL.query!(Repo, "delete from runs where id in (?, ?, ?)", [workflow_id, service_id, caller_run_id])
    end
  end

  defp row_map(%{columns: columns, rows: [row | _]}) do
    columns
    |> Enum.zip(row)
    |> Map.new()
  end
end
