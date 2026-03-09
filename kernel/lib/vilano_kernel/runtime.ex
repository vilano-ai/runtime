defmodule VilanoKernel.Runtime do
  @moduledoc false

  defstruct [
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
    :lease_duration_seconds
  ]

  def load! do
    home_dir =
      System.get_env("VILANO_HOME") ||
        Path.join(System.user_home!(), ".vilano")

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

    lease_duration_seconds =
      case System.get_env("VILANO_LEASE_DURATION_SECONDS", "30") do
        value when is_binary(value) ->
          String.to_integer(value)
      end

    %__MODULE__{
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
      lease_duration_seconds: lease_duration_seconds
    }
  end

  defp default_execution_home_dir(home_dir) do
    home_dir = Path.expand(home_dir)
    parent_dir = Path.dirname(home_dir)
    base_name = sanitize_path_segment(Path.basename(home_dir))

    suffix =
      :crypto.hash(:sha256, home_dir)
      |> Base.encode16(case: :lower)
      |> binary_part(0, 12)

    Path.join(parent_dir, ".#{base_name}-execution-#{suffix}")
  end

  defp sanitize_path_segment(value) when is_binary(value) do
    Regex.replace(~r/[^A-Za-z0-9._-]+/, value, "_")
  end
end
