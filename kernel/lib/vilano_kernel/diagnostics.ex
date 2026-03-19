defmodule VilanoKernel.Diagnostics do
  @moduledoc false

  use Agent

  require Logger

  @max_recent_exhausted 10

  def start_link(_arg) do
    Agent.start_link(fn -> initial_state() end, name: __MODULE__)
  end

  def snapshot do
    Agent.get(__MODULE__, & &1)
  end

  def record_busy_retry(profile, reason, delay_ms) do
    update_profile(profile, fn entry ->
      now = now_iso8601()

      %{
        entry
        | retries: entry.retries + 1,
          lastRetryAt: now,
          lastReason: normalize_reason(reason),
          lastDelayMs: delay_ms
      }
    end)
  end

  def record_busy_retry_exhausted(profile, reason) do
    normalized_reason = normalize_reason(reason)
    now = now_iso8601()

    Agent.update(__MODULE__, fn state ->
      entry =
        state
        |> profile_entry(profile)
        |> then(fn existing ->
          %{
            existing
            | exhausted: existing.exhausted + 1,
              lastExhaustedAt: now,
              lastReason: normalized_reason
          }
        end)

      recent_exhausted =
        [
          %{
            "profile" => profile_name(profile),
            "reason" => normalized_reason,
            "at" => now
          }
          | state.busyRetries.recentExhausted
        ]
        |> Enum.take(@max_recent_exhausted)

      put_profile_entry(state, profile, entry)
      |> put_in([:busyRetries, :recentExhausted], recent_exhausted)
    end)

    Logger.warning(
      "sqlite busy retry exhausted profile=#{profile_name(profile)} reason=#{normalized_reason}"
    )
  end

  defp update_profile(profile, fun) do
    Agent.update(__MODULE__, fn state ->
      entry =
        state
        |> profile_entry(profile)
        |> fun.()

      put_profile_entry(state, profile, entry)
    end)
  end

  defp profile_entry(state, profile) do
    get_in(state, [:busyRetries, :profiles, profile_name(profile)]) ||
      %{
        retries: 0,
        exhausted: 0,
        lastRetryAt: nil,
        lastExhaustedAt: nil,
        lastReason: nil,
        lastDelayMs: nil
      }
  end

  defp put_profile_entry(state, profile, entry) do
    put_in(state, [:busyRetries, :profiles, profile_name(profile)], entry)
  end

  defp profile_name(profile) when is_atom(profile), do: Atom.to_string(profile)
  defp profile_name(profile) when is_binary(profile), do: profile
  defp profile_name(_profile), do: "custom"

  defp normalize_reason(reason) when is_exception(reason) do
    reason
    |> Exception.message()
    |> normalize_reason()
  end

  defp normalize_reason(reason) when is_binary(reason) do
    reason
    |> String.trim()
    |> String.slice(0, 300)
  end

  defp normalize_reason(reason), do: inspect(reason)

  defp now_iso8601 do
    DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
  end

  defp initial_state do
    %{
      busyRetries: %{
        profiles: %{},
        recentExhausted: []
      }
    }
  end
end
