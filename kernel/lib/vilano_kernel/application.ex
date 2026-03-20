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

    repo_config = runtime_repo_config(runtime.runtime_db_path, repo_pool_size())

    Application.put_env(:vilano_kernel, VilanoKernel.Repo, repo_config)

    bootstrap_storage!(bootstrap_repo_config(runtime.runtime_db_path))

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

  defp runtime_repo_config(database, pool_size) do
    common_repo_config(database, pool_size)
    |> Keyword.put(:journal_mode, nil)
  end

  defp bootstrap_repo_config(database) do
    common_repo_config(database, 1)
    |> Keyword.put(:journal_mode, :wal)
  end

  defp common_repo_config(database, pool_size) do
    [
      database: database,
      pool_size: pool_size,
      busy_timeout: 5_000,
      custom_pragmas: [busy_timeout: 5_000]
    ]
  end

  defp bootstrap_storage!(repo_config) do
    {:ok, repo_pid} =
      VilanoKernel.Repo.start_link(
        Keyword.put(repo_config, :pool_size, 1)
      )

    try do
      VilanoKernel.Storage.init!()
    after
      Supervisor.stop(repo_pid)
    end
  end
end
