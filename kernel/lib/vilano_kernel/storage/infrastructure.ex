defmodule VilanoKernel.Storage.Infrastructure do
  @moduledoc false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.Migrations
  alias VilanoKernel.Storage.RuntimeMetadata

  def init! do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)
    configure_database!()
    bootstrap_schema!()
    Migrations.ensure_tracking_table!()
    Migrations.run_pending!()
    RuntimeMetadata.sync_runtime_metadata!()
    maybe_chmod_runtime_db(runtime.runtime_db_path)
  end

  def run_with_busy_retry(fun, attempts_left \\ 4)

  def run_with_busy_retry(fun, attempts_left) do
    case fun.() do
      {:error, reason} = result ->
        if attempts_left > 1 and busy_reason?(reason) do
          Process.sleep(busy_retry_delay_ms(attempts_left))
          run_with_busy_retry(fun, attempts_left - 1)
        else
          result
        end

      result ->
        result
    end
  rescue
    error ->
      if attempts_left > 1 and busy_reason?(error) do
        Process.sleep(busy_retry_delay_ms(attempts_left))
        run_with_busy_retry(fun, attempts_left - 1)
      else
        reraise error, __STACKTRACE__
      end
  end

  def transaction_with_busy_retry(fun, attempts_left \\ 4)

  def transaction_with_busy_retry(fun, attempts_left) do
    run_with_busy_retry(
      fn ->
        Repo.transaction(fun)
      end,
      attempts_left
    )
  end

  def now_iso8601 do
    DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
  end

  def lease_duration_seconds do
    Application.fetch_env!(:vilano_kernel, :runtime).lease_duration_seconds
  end

  defp busy_reason?(reason) when is_exception(reason) do
    reason
    |> Exception.message()
    |> String.downcase()
    |> busy_message?()
  end

  defp busy_reason?(reason) when is_binary(reason) do
    reason
    |> String.downcase()
    |> busy_message?()
  end

  defp busy_reason?(_reason), do: false

  defp busy_message?(message) do
    String.contains?(message, "database busy") or
      String.contains?(message, "database is locked") or
      String.contains?(message, "busy")
  end

  defp busy_retry_delay_ms(attempts_left), do: 25 * (5 - attempts_left + 1)

  defp configure_database! do
    SQL.query!(Repo, "pragma journal_mode = wal", [])
    SQL.query!(Repo, "pragma foreign_keys = on", [])
    SQL.query!(Repo, "pragma busy_timeout = 5000", [])
  end

  defp maybe_chmod_runtime_db(runtime_db_path) do
    case File.chmod(runtime_db_path, 0o600) do
      :ok -> :ok
      {:error, _reason} -> :ok
    end
  end

  defp bootstrap_schema! do
    SQL.query!(
      Repo,
      """
      create table if not exists projects (
        name text primary key,
        path text not null,
        snapshot_path text,
        last_synced_at text,
        definitions_manifest_hash text,
        workflows_json text not null,
        services_json text not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists runs (
        id text primary key,
        project_name text not null,
        definition_kind text not null,
        definition_name text not null,
        project_snapshot_path text,
        project_definitions_json text,
        definition_file text,
        definition_export_name text,
        definition_runtime_kind text,
        definition_source_language text,
        status text not null,
        trap_exits integer not null default 0,
        lease_id text,
        lease_auth_token text,
        lease_worker_id text,
        lease_expires_at text,
        input_json text not null,
        output_json text,
        error_json text,
        created_at text not null,
        updated_at text not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_relationships (
        id text primary key,
        owner_run_id text not null,
        op_key text not null,
        target_run_id text not null,
        kind text not null,
        propagate text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        unique (owner_run_id, op_key)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_exit_events (
        id text primary key,
        run_id text not null,
        relationship_id text not null,
        event_json text not null,
        consumed_at text,
        created_at text not null,
        unique (relationship_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_events (
        id text primary key,
        run_id text not null,
        seq integer not null,
        event_type text not null,
        body_json text not null,
        created_at text not null,
        unique (run_id, seq)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_event_sequences (
        run_id text primary key,
        next_seq integer not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_steps (
        run_id text not null,
        op_key text not null,
        name text not null,
        status text not null,
        attempt integer,
        max_attempts integer,
        backoff_kind text,
        backoff_ms integer,
        backoff_step_ms integer,
        backoff_factor real,
        max_backoff_ms integer,
        backoff_jitter_kind text,
        backoff_jitter_ratio real,
        retry_on_json text,
        timeout_ms integer,
        output_json text,
        error_json text,
        created_at text not null,
        updated_at text not null,
        primary key (run_id, op_key)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_execs (
        run_id text not null,
        op_key text not null,
        name text not null,
        status text not null,
        cmd text not null,
        args_json text not null,
        cwd text,
        env_json text,
        timeout_ms integer,
        attempt integer not null,
        exit_code integer,
        signal_code text,
        stdout_ref text,
        stderr_ref text,
        artifacts_json text,
        output_json text,
        error_json text,
        created_at text not null,
        updated_at text not null,
        primary key (run_id, op_key)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_waits (
        run_id text not null,
        op_key text not null,
        wait_kind text not null,
        wait_name text not null,
        status text not null,
        wake_at text,
        output_json text,
        created_at text not null,
        updated_at text not null,
        primary key (run_id, op_key)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_children (
        parent_run_id text not null,
        op_key text not null,
        child_run_id text not null,
        definition_name text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        primary key (parent_run_id, op_key),
        unique (child_run_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_supervision_groups (
        id text primary key,
        owner_run_id text not null,
        op_key text not null,
        strategy text not null,
        max_restarts integer not null,
        window_ms integer not null,
        on_exhausted text not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        unique (owner_run_id, op_key)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_supervision_members (
        group_id text not null,
        member_key text not null,
        definition_name text not null,
        input_json text not null,
        current_child_run_id text,
        generation integer not null,
        status text not null,
        created_at text not null,
        updated_at text not null,
        primary key (group_id, member_key),
        unique (current_child_run_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_supervision_restarts (
        id text primary key,
        group_id text not null,
        member_key text not null,
        child_run_id text not null,
        created_at text not null,
        unique (child_run_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_service_refs (
        caller_run_id text not null,
        service_run_id text not null,
        created_at text not null,
        primary key (caller_run_id, service_run_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists service_runs (
        run_id text primary key,
        service_key text not null,
        key_input_json text not null,
        state_json text,
        created_at text not null,
        updated_at text not null,
        unique (run_id)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists service_envelopes (
        id text primary key,
        service_run_id text not null,
        kind text not null,
        name text not null,
        attempt integer,
        payload_json text,
        correlation_id text,
        sender_run_id text,
        status text not null,
        reply_json text,
        error_json text,
        wake_at text,
        created_at text not null,
        updated_at text not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_service_ops (
        caller_run_id text not null,
        op_key text not null,
        service_run_id text not null,
        op_kind text not null,
        message_name text not null,
        correlation_id text,
        status text not null,
        payload_json text not null,
        response_json text,
        error_json text,
        created_at text not null,
        updated_at text not null,
        primary key (caller_run_id, op_key)
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create table if not exists run_signals (
        id text primary key,
        run_id text not null,
        signal_name text not null,
        payload_json text,
        consumed_at text,
        created_at text not null
      )
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists runs_project_created_at_idx
      on runs(project_name, created_at desc)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_events_run_seq_idx
      on run_events(run_id, seq)
      """,
      []
    )

    maybe_create_service_envelope_wake_index!()

    SQL.query!(
      Repo,
      """
      create index if not exists run_relationships_target_status_idx
      on run_relationships(target_run_id, status, created_at)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_exit_events_run_consumed_created_idx
      on run_exit_events(run_id, consumed_at, created_at)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_supervision_groups_owner_status_idx
      on run_supervision_groups(owner_run_id, status, created_at)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_supervision_members_child_idx
      on run_supervision_members(current_child_run_id)
      """,
      []
    )

    SQL.query!(
      Repo,
      """
      create index if not exists run_supervision_restarts_group_created_idx
      on run_supervision_restarts(group_id, created_at)
      """,
      []
    )
  end

  defp maybe_create_service_envelope_wake_index! do
    %{rows: rows} =
      SQL.query!(
        Repo,
        """
        pragma table_info(service_envelopes)
        """,
        []
      )

    has_wake_at? =
      Enum.any?(rows, fn row ->
        Enum.at(row, 1) == "wake_at"
      end)

    if has_wake_at? do
      SQL.query!(
        Repo,
        """
        create index if not exists service_envelopes_run_status_wake_created_idx
        on service_envelopes(service_run_id, status, wake_at, created_at)
        """,
        []
      )
    end
  end
end
