defmodule VilanoKernel.PruneManager do
  @moduledoc false

  use GenServer

  require Logger

  @default_interval_seconds 3_600

  def start_link(_arg) do
    case config_from_env() do
      nil -> :ignore
      config -> GenServer.start_link(__MODULE__, config, name: __MODULE__)
    end
  end

  @impl true
  def init(config) do
    send(self(), :prune)
    {:ok, config}
  end

  @impl true
  def handle_info(:prune, config) do
    prune_once(config)
    Process.send_after(self(), :prune, config.interval_ms)
    {:noreply, config}
  end

  defp config_from_env do
    case prune_opts_from_env() do
      {:ok, opts} ->
        if map_size_without_vacuum(opts) > 0 do
          %{
            interval_ms: prune_interval_ms(),
            opts: opts
          }
        else
          nil
        end

      {:error, errors} ->
        Logger.warning("Runtime auto-prune disabled: #{Enum.join(errors, "; ")}")
        nil
    end
  end

  defp prune_interval_ms do
    seconds =
      "VILANO_PRUNE_INTERVAL_SECONDS"
      |> System.get_env()
      |> parse_positive_integer(@default_interval_seconds)

    seconds * 1_000
  end

  defp map_size_without_vacuum(opts) do
    opts
    |> Map.delete("vacuumDatabase")
    |> map_size()
  end

  defp prune_opts_from_env do
    {opts, errors} =
      {%{}, []}
      |> put_optional_integer("runWorkspaceTtlSeconds", "VILANO_PRUNE_RUN_WORKSPACE_TTL_SECONDS")
      |> put_optional_integer("completedRunTtlSeconds", "VILANO_PRUNE_COMPLETED_RUN_TTL_SECONDS")
      |> put_optional_integer(
        "serviceEnvelopeTtlSeconds",
        "VILANO_PRUNE_SERVICE_ENVELOPE_TTL_SECONDS"
      )
      |> put_optional_integer("artifactGraceSeconds", "VILANO_PRUNE_ARTIFACT_GRACE_SECONDS")
      |> put_optional_integer(
        "eventPayloadGraceSeconds",
        "VILANO_PRUNE_EVENT_PAYLOAD_GRACE_SECONDS"
      )
      |> put_optional_integer("runtimeCacheTtlSeconds", "VILANO_PRUNE_RUNTIME_CACHE_TTL_SECONDS")
      |> put_optional_integer("daemonLogMaxBytes", "VILANO_PRUNE_DAEMON_LOG_MAX_BYTES")
      |> put_optional_boolean("vacuumDatabase", "VILANO_PRUNE_VACUUM_DATABASE")

    if errors == [] do
      {:ok, opts}
    else
      {:error, Enum.reverse(errors)}
    end
  end

  defp put_optional_integer({opts, errors}, option_key, env_key) do
    case System.get_env(env_key) do
      value when is_binary(value) ->
        trimmed = String.trim(value)

        case Integer.parse(trimmed) do
          {parsed, ""} when parsed >= 0 -> {Map.put(opts, option_key, parsed), errors}
          _ -> {opts, ["#{env_key} must be a non-negative integer" | errors]}
        end

      _ ->
        {opts, errors}
    end
  end

  defp put_optional_boolean({opts, errors}, option_key, env_key) do
    case System.get_env(env_key) do
      value when is_binary(value) ->
        case String.downcase(String.trim(value)) do
          "1" -> {Map.put(opts, option_key, true), errors}
          "true" -> {Map.put(opts, option_key, true), errors}
          "yes" -> {Map.put(opts, option_key, true), errors}
          "0" -> {Map.put(opts, option_key, false), errors}
          "false" -> {Map.put(opts, option_key, false), errors}
          "no" -> {Map.put(opts, option_key, false), errors}
          _ -> {opts, ["#{env_key} must be a boolean" | errors]}
        end

      _ ->
        {opts, errors}
    end
  end

  defp parse_positive_integer(value, default) when is_binary(value) do
    case Integer.parse(String.trim(value)) do
      {parsed, ""} when parsed > 0 -> parsed
      _ -> default
    end
  end

  defp parse_positive_integer(_value, default), do: default

  defp prune_once(%{opts: opts}) do
    case VilanoKernel.Storage.prune_runtime(opts) do
      %{ok: true} ->
        :ok

      %{ok: false, error: error} ->
        Logger.warning("Runtime auto-prune skipped: #{inspect(error)}")
    end
  rescue
    error ->
      Logger.warning("Runtime auto-prune failed: #{Exception.message(error)}")
  end
end
