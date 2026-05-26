defmodule VilanoKernel.Runtime do
  @moduledoc false

  defstruct [
    :install_root_dir,
    :home_dir,
    :execution_home_dir,
    :artifact_home_dir,
    :runtime_db_path,
    :port,
    :started_at,
    :project_root,
    :auth_token,
    :worker_auth_token,
    :managed_worker_count,
    :managed_worker_runtime,
    :managed_worker_mode,
    :lease_duration_seconds,
    :event_payload_max_bytes
  ]

  def load! do
    install_root_dir =
      System.get_env("VILANO_INSTALL_ROOT") ||
        default_install_root_dir(System.get_env("VILANO_HOME"))

    home_dir =
      System.get_env("VILANO_HOME") ||
        Path.join(install_root_dir, "state")

    execution_home_dir =
      System.get_env("VILANO_EXECUTION_HOME") ||
        default_execution_home_dir(home_dir)

    project_root =
      case System.get_env("VILANO_ROOT") do
        nil -> Path.expand("..", File.cwd!())
        value -> Path.expand(value)
      end

    port =
      case System.get_env("VILANO_KERNEL_PORT", "4141") do
        value when is_binary(value) ->
          String.to_integer(value)
      end

    managed_worker_count =
      case System.get_env("VILANO_MANAGED_WORKERS", "1") do
        value when is_binary(value) ->
          String.to_integer(value)
      end

    managed_worker_runtime = System.get_env("VILANO_MANAGED_WORKER_RUNTIME", "bun")
    managed_worker_mode = System.get_env("VILANO_MANAGED_WORKER_MODE", "per_activation")

    lease_duration_seconds =
      case System.get_env("VILANO_LEASE_DURATION_SECONDS", "30") do
        value when is_binary(value) ->
          String.to_integer(value)
      end

    event_payload_max_bytes =
      parse_non_negative_integer_env("VILANO_EVENT_PAYLOAD_MAX_BYTES", 65_536)

    %__MODULE__{
      install_root_dir: install_root_dir,
      home_dir: home_dir,
      execution_home_dir: execution_home_dir,
      artifact_home_dir: Path.join(execution_home_dir, "artifacts"),
      runtime_db_path: Path.join(home_dir, "runtime.sqlite"),
      port: port,
      started_at: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601(),
      project_root: project_root,
      auth_token: System.get_env("VILANO_DAEMON_TOKEN"),
      worker_auth_token: System.get_env("VILANO_WORKER_TOKEN"),
      managed_worker_count: managed_worker_count,
      managed_worker_runtime: managed_worker_runtime,
      managed_worker_mode: managed_worker_mode,
      lease_duration_seconds: lease_duration_seconds,
      event_payload_max_bytes: event_payload_max_bytes
    }
  end

  defp parse_non_negative_integer_env(name, default_value) do
    case System.get_env(name) do
      nil ->
        default_value

      value ->
        case Integer.parse(value) do
          {parsed, ""} when parsed >= 0 -> parsed
          _ -> default_value
        end
    end
  end

  defp default_execution_home_dir(home_dir) do
    Path.join(Path.expand(home_dir), "execution")
  end

  defp default_install_root_dir(nil), do: Path.join(System.user_home!(), ".vilano")

  defp default_install_root_dir(home_dir) do
    expanded_home_dir = Path.expand(home_dir)

    case Path.basename(expanded_home_dir) do
      "state" -> Path.dirname(expanded_home_dir)
      _ -> expanded_home_dir
    end
  end
end
