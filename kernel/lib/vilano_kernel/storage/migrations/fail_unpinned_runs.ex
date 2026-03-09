defmodule VilanoKernel.Storage.Migrations.FailUnpinnedRuns do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo

  def version, do: 8
  def name, do: "fail_unpinned_runs"

  def up do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()

    error_json =
      Jason.encode!(%{
        "message" => "Run cannot resume because it predates pinned project snapshots and definitions.",
        "reason" => "missing_pinned_definition"
      })

    unpinned_predicate = """
    (
      project_snapshot_path is null
      or project_definitions_json is null
      or definition_file is null
      or definition_export_name is null
      or definition_runtime_kind is null
      or definition_source_language is null
    )
    """

    SQL.query!(
      Repo,
      """
      update runs
      set
        status = 'failed',
        lease_id = null,
        lease_auth_token = null,
        lease_worker_id = null,
        lease_expires_at = null,
        output_json = null,
        error_json = ?,
        updated_at = ?
      where
        definition_kind = 'workflow'
        and #{unpinned_predicate}
        and status in ('pending', 'running', 'waiting', 'active')
      """,
      [error_json, now]
    )

    SQL.query!(
      Repo,
      """
      update runs
      set
        status = 'stopped',
        lease_id = null,
        lease_auth_token = null,
        lease_worker_id = null,
        lease_expires_at = null,
        output_json = null,
        error_json = ?,
        updated_at = ?
      where
        definition_kind = 'service'
        and #{unpinned_predicate}
        and status in ('pending', 'running', 'waiting', 'active', 'idle')
      """,
      [error_json, now]
    )

    SQL.query!(
      Repo,
      """
      update service_envelopes
      set
        status = 'failed',
        reply_json = null,
        error_json = ?,
        updated_at = ?
      where
        status in ('queued', 'processing')
        and service_run_id in (
          select id
          from runs
          where
            definition_kind = 'service'
            and #{unpinned_predicate}
        )
      """,
      [error_json, now]
    )

    SQL.query!(
      Repo,
      """
      update run_service_ops
      set
        status = 'failed',
        response_json = null,
        error_json = ?,
        updated_at = ?
      where
        op_kind = 'ask'
        and status = 'waiting'
        and service_run_id in (
          select id
          from runs
          where
            definition_kind = 'service'
            and #{unpinned_predicate}
        )
      """,
      [error_json, now]
    )

    SQL.query!(
      Repo,
      """
      update run_waits
      set
        status = 'failed',
        output_json = ?,
        updated_at = ?
      where
        status = 'waiting'
        and wait_kind = 'ask_reply'
        and wait_name in (
          select correlation_id
          from run_service_ops
          where
            op_kind = 'ask'
            and status = 'failed'
            and error_json = ?
            and service_run_id in (
              select id
              from runs
              where
                definition_kind = 'service'
                and #{unpinned_predicate}
            )
        )
      """,
      [error_json, now, error_json]
    )

    SQL.query!(
      Repo,
      """
      update runs
      set
        status = 'pending',
        lease_id = null,
        lease_auth_token = null,
        lease_worker_id = null,
        lease_expires_at = null,
        updated_at = ?
      where
        status = 'waiting'
        and id in (
          select caller_run_id
          from run_service_ops
          where
            op_kind = 'ask'
            and status = 'failed'
            and error_json = ?
            and service_run_id in (
              select id
              from runs
              where
                definition_kind = 'service'
                and #{unpinned_predicate}
            )
        )
        and not #{unpinned_predicate}
      """,
      [now, error_json]
    )

    SQL.query!(
      Repo,
      """
      update run_waits
      set
        status = 'failed',
        output_json = ?,
        updated_at = ?
      where
        status = 'waiting'
        and run_id in (
          select id
          from runs
          where #{unpinned_predicate}
        )
      """,
      [error_json, now]
    )
  end
end
