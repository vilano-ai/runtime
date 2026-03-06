defmodule VilanoKernel.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    runtime = VilanoKernel.Runtime.load!()
    File.mkdir_p!(runtime.home_dir)

    Application.put_env(:vilano_kernel, :runtime, runtime)

    Application.put_env(:vilano_kernel, VilanoKernel.Repo,
      database: runtime.runtime_db_path,
      pool_size: 5
    )

    children = [
      VilanoKernel.RuntimeSupervisor
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: VilanoKernel.Supervisor)
  end
end
