defmodule VilanoKernel.RuntimeSupervisor do
  @moduledoc """
  Top-level supervisor placeholder for the v1 kernel process tree.
  """

  use Supervisor

  def start_link(arg) do
    Supervisor.start_link(__MODULE__, arg, name: __MODULE__)
  end

  @impl true
  def init(_arg) do
    runtime = Application.fetch_env!(:vilano_kernel, :runtime)

    children = [
      VilanoKernel.Repo,
      Supervisor.child_spec({Task, &VilanoKernel.Storage.init!/0},
        id: VilanoKernel.StorageBootstrap,
        restart: :transient
      ),
      VilanoKernel.WaitManager,
      {Bandit, plug: VilanoKernel.Router, scheme: :http, port: runtime.port, ip: {127, 0, 0, 1}}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
