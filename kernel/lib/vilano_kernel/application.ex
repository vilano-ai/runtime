defmodule VilanoKernel.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    runtime = VilanoKernel.Runtime.load!()
    File.mkdir_p!(runtime.home_dir)
    File.mkdir_p!(runtime.execution_home_dir)
    File.mkdir_p!(runtime.artifact_home_dir)
    File.chmod(runtime.home_dir, 0o700)
    File.chmod(runtime.execution_home_dir, 0o700)
    File.chmod(runtime.artifact_home_dir, 0o700)

    Application.put_env(:vilano_kernel, :runtime, runtime)

    Application.put_env(:vilano_kernel, VilanoKernel.Repo,
      database: runtime.runtime_db_path,
      pool_size: repo_pool_size()
    )

    children = [
      VilanoKernel.RuntimeSupervisor
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: VilanoKernel.Supervisor)
  end

  defp repo_pool_size do
    case System.get_env("VILANO_REPO_POOL_SIZE") do
      nil ->
        5

      value ->
        case Integer.parse(value) do
          {parsed, ""} when parsed > 0 -> parsed
          _ -> 5
        end
    end
  end
end
