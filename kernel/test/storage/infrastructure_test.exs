defmodule VilanoKernel.Storage.InfrastructureTest do
  use ExUnit.Case, async: true

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
end
