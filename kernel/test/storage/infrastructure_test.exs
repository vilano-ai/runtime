defmodule VilanoKernel.Storage.InfrastructureTest do
  use ExUnit.Case, async: true

  alias Ecto.Adapters.SQL
  alias VilanoKernel.Repo
  alias VilanoKernel.Storage.Infrastructure

  test "run_with_busy_retry retries busy exceptions" do
    attempts = :atomics.new(1, [])

    result =
      Infrastructure.run_with_busy_retry(fn ->
        attempt = :atomics.add_get(attempts, 1, 1)

        if attempt < 5 do
          raise "database is locked"
        end

        :ok
      end)

    assert result == :ok
    assert :atomics.get(attempts, 1) == 5
  end

  test "run_with_busy_retry retries busy error tuples" do
    attempts = :atomics.new(1, [])

    result =
      Infrastructure.run_with_busy_retry(fn ->
        attempt = :atomics.add_get(attempts, 1, 1)

        if attempt < 3 do
          {:error, "database busy"}
        else
          {:ok, :done}
        end
      end)

    assert result == {:ok, :done}
    assert :atomics.get(attempts, 1) == 3
  end

  test "run_with_busy_retry retries connection pool queue pressure" do
    attempts = :atomics.new(1, [])

    result =
      Infrastructure.run_with_busy_retry(fn ->
        attempt = :atomics.add_get(attempts, 1, 1)

        if attempt < 3 do
          raise "connection not available and request was dropped from queue after 100ms"
        end

        :ok
      end)

    assert result == :ok
    assert :atomics.get(attempts, 1) == 3
  end

  test "run_with_busy_retry does not retry non-busy errors" do
    attempts = :atomics.new(1, [])

    result =
      Infrastructure.run_with_busy_retry(fn ->
        :atomics.add_get(attempts, 1, 1)
        {:error, "validation failed"}
      end)

    assert result == {:error, "validation failed"}
    assert :atomics.get(attempts, 1) == 1
  end

  test "run_with_busy_retry applies the run creation retry profile" do
    attempts = :atomics.new(1, [])

    result =
      Infrastructure.run_with_busy_retry(
        fn ->
          attempt = :atomics.add_get(attempts, 1, 1)

          if attempt < 6 do
            raise "database busy"
          end

          :ok
        end,
        :run_creation
      )

    assert result == :ok
    assert :atomics.get(attempts, 1) == 6
  end

  test "run_with_busy_retry applies the admin control retry profile" do
    attempts = :atomics.new(1, [])

    result =
      Infrastructure.run_with_busy_retry(
        fn ->
          attempt = :atomics.add_get(attempts, 1, 1)

          if attempt < 8 do
            raise "database busy"
          end

          :ok
        end,
        :admin_control
      )

    assert result == :ok
    assert :atomics.get(attempts, 1) == 8
  end

  test "run_with_busy_retry applies the public read retry profile" do
    attempts = :atomics.new(1, [])

    result =
      Infrastructure.run_with_busy_retry(
        fn ->
          attempt = :atomics.add_get(attempts, 1, 1)

          if attempt < 6 do
            raise "connection not available"
          end

          :ok
        end,
        :public_read
      )

    assert result == :ok
    assert :atomics.get(attempts, 1) == 6
  end

  test "run_with_busy_retry accepts custom retry policies" do
    attempts = :atomics.new(1, [])

    result =
      Infrastructure.run_with_busy_retry(
        fn ->
          attempt = :atomics.add_get(attempts, 1, 1)

          if attempt < 4 do
            {:error, "database is locked"}
          else
            :ok
          end
        end,
        attempts: 5,
        base_delay_ms: 1,
        multiplier: 2.0,
        max_delay_ms: 10
      )

    assert result == :ok
    assert :atomics.get(attempts, 1) == 4
  end

  test "runtime prune indexes exist" do
    assert "runs_definition_status_lease_updated_idx" in table_indexes("runs")
    assert "runs_lease_status_idx" in table_indexes("runs")
    assert "runs_status_lease_idx" in table_indexes("runs")
    assert "run_events_event_type_idx" in table_indexes("run_events")
    assert "run_signals_run_created_idx" in table_indexes("run_signals")
    assert "service_envelopes_status_updated_idx" in table_indexes("service_envelopes")
    assert "service_envelopes_sender_run_idx" in table_indexes("service_envelopes")
    assert "run_service_refs_service_run_idx" in table_indexes("run_service_refs")
  end

  test "active artifact run query uses indexes" do
    plan =
      """
      explain query plan
      select id
      from runs indexed by runs_lease_status_idx
      where lease_id is not null

      union

      select id
      from runs indexed by runs_status_lease_idx
      where status in ('pending', 'running', 'waiting', 'active', 'idle')
      """
      |> query_plan_details()
      |> Enum.join("\n")

    assert plan =~ "runs_lease_status_idx"
    assert plan =~ "runs_status_lease_idx"
    refute plan =~ "SCAN runs"
  end

  test "prune retention and delete queries use supporting indexes" do
    event_plan =
      """
      explain query plan
      select id, body_json
      from run_events
      where event_type in ('ProcessCompleted', 'ProcessFailed', 'StepFailed', 'TurnFailed')
      """
      |> query_plan_details()
      |> Enum.join("\n")

    signal_delete_plan =
      """
      explain query plan
      delete from run_signals
      where run_id in ('run_query_plan')
      """
      |> query_plan_details()
      |> Enum.join("\n")

    assert event_plan =~ "run_events_event_type_idx"
    assert signal_delete_plan =~ "run_signals_run_created_idx"
  end

  defp table_indexes(table_name) do
    Repo
    |> SQL.query!("pragma index_list(#{table_name})", [])
    |> Map.fetch!(:rows)
    |> Enum.map(fn row -> Enum.at(row, 1) end)
  end

  defp query_plan_details(query) do
    Repo
    |> SQL.query!(query, [])
    |> Map.fetch!(:rows)
    |> Enum.map(fn row -> row |> List.last() |> to_string() end)
  end
end
