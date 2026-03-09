defmodule VilanoKernel.Storage.TimerFencingTest do
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage

  test "ignores stale timed-wait deliveries for a rescheduled wake time" do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    wake_at = DateTime.utc_now() |> DateTime.add(2, :second) |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    stale_wake_at = DateTime.utc_now() |> DateTime.add(1, :second) |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    run_id = "run_" <> Ecto.UUID.generate()

    insert_run!(run_id, now, %{status: "waiting"})

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
      ) values (?, 'nap', 'sleep', 'sleep', 'waiting', ?, null, ?, ?)
      """,
      [run_id, wake_at, now, now]
    )

    assert Storage.satisfy_timed_wait(run_id, "nap", stale_wake_at) == nil

    wait =
      SQL.query!(Repo, "select status, wake_at from run_waits where run_id = ? and op_key = 'nap'", [run_id])
      |> row_map()

    assert wait["status"] == "waiting"
    assert wait["wake_at"] == wake_at
  end

  test "ignores stale step timeout deliveries for an older attempt" do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    lease_expires_at = DateTime.utc_now() |> DateTime.add(30, :second) |> DateTime.truncate(:millisecond) |> DateTime.to_iso8601()
    run_id = "run_" <> Ecto.UUID.generate()
    lease_id = "lease_" <> Ecto.UUID.generate()
    lease_auth_token = "lease_auth_" <> Ecto.UUID.generate()

    insert_run!(run_id, now, %{
      status: "active",
      lease_id: lease_id,
      lease_auth_token: lease_auth_token,
      lease_worker_id: "managed-local-1",
      lease_expires_at: lease_expires_at
    })

    SQL.query!(
      Repo,
      """
      insert into run_steps (
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
      ) values (?, 'slow-step', 'slow-step', 'running', 2, null, null, null, null, null, null, null, null, null, 100, null, null, ?, ?)
      """,
      [run_id, now, now]
    )

    assert Storage.timeout_step(lease_id, "slow-step", 1, %{"message" => "stale timeout"}) == nil

    step =
      SQL.query!(Repo, "select status, attempt from run_steps where run_id = ? and op_key = 'slow-step'", [run_id])
      |> row_map()

    assert step["status"] == "running"
    assert step["attempt"] == 2
  end

  defp insert_run!(run_id, now, attrs) do
    status = Map.get(attrs, :status, "pending")
    lease_id = Map.get(attrs, :lease_id)
    lease_auth_token = Map.get(attrs, :lease_auth_token)
    lease_worker_id = Map.get(attrs, :lease_worker_id)
    lease_expires_at = Map.get(attrs, :lease_expires_at)

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
      ) values (?, 'demo', 'workflow', 'timerProbe', '/tmp/project', '{}', 'src/definitions.ts', 'timerProbe', 'javascript', 'typescript', ?, ?, ?, ?, ?, '{}', null, null, ?, ?)
      """,
      [run_id, status, lease_id, lease_auth_token, lease_worker_id, lease_expires_at, now, now]
    )
  end

  defp row_map(%{rows: [row], columns: columns}) do
    Enum.zip(columns, row) |> Map.new()
  end
end
