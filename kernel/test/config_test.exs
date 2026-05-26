defmodule VilanoKernel.ConfigTest do
  use ExUnit.Case, async: false

  alias VilanoKernel.Runtime

  setup do
    event_payload_max_bytes = System.get_env("VILANO_EVENT_PAYLOAD_MAX_BYTES")
    sqlite_busy_timeout_ms = System.get_env("VILANO_SQLITE_BUSY_TIMEOUT_MS")

    on_exit(fn ->
      restore_env("VILANO_EVENT_PAYLOAD_MAX_BYTES", event_payload_max_bytes)
      restore_env("VILANO_SQLITE_BUSY_TIMEOUT_MS", sqlite_busy_timeout_ms)
    end)
  end

  test "loads MIX_ENV-specific config" do
    {config, _imports} =
      Config.Reader.read_imports!(
        Path.expand("../config/config.exs", __DIR__),
        env: :test
      )

    assert config[:vilano_kernel][:test_config_loaded]
  end

  test "runtime parses VILANO_EVENT_PAYLOAD_MAX_BYTES" do
    System.delete_env("VILANO_EVENT_PAYLOAD_MAX_BYTES")
    assert Runtime.load!().event_payload_max_bytes == 65_536

    System.put_env("VILANO_EVENT_PAYLOAD_MAX_BYTES", "0")
    assert Runtime.load!().event_payload_max_bytes == 0

    System.put_env("VILANO_EVENT_PAYLOAD_MAX_BYTES", "2048")
    assert Runtime.load!().event_payload_max_bytes == 2_048

    System.put_env("VILANO_EVENT_PAYLOAD_MAX_BYTES", "-1")
    assert Runtime.load!().event_payload_max_bytes == 65_536

    System.put_env("VILANO_EVENT_PAYLOAD_MAX_BYTES", "invalid")
    assert Runtime.load!().event_payload_max_bytes == 65_536
  end

  test "runtime parses VILANO_SQLITE_BUSY_TIMEOUT_MS" do
    System.delete_env("VILANO_SQLITE_BUSY_TIMEOUT_MS")
    assert Runtime.load!().sqlite_busy_timeout_ms == 5_000

    System.put_env("VILANO_SQLITE_BUSY_TIMEOUT_MS", "0")
    assert Runtime.load!().sqlite_busy_timeout_ms == 0

    System.put_env("VILANO_SQLITE_BUSY_TIMEOUT_MS", "15000")
    assert Runtime.load!().sqlite_busy_timeout_ms == 15_000

    System.put_env("VILANO_SQLITE_BUSY_TIMEOUT_MS", "-1")
    assert Runtime.load!().sqlite_busy_timeout_ms == 5_000

    System.put_env("VILANO_SQLITE_BUSY_TIMEOUT_MS", "invalid")
    assert Runtime.load!().sqlite_busy_timeout_ms == 5_000
  end

  defp restore_env(name, nil), do: System.delete_env(name)
  defp restore_env(name, value), do: System.put_env(name, value)
end
