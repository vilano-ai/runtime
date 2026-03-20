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

    core_children = [
      VilanoKernel.Repo,
      VilanoKernel.Diagnostics,
      VilanoKernel.WaitManager,
      VilanoKernel.StepDeadlineManager,
      {Bandit, plug: VilanoKernel.Router, scheme: :http, port: runtime.port, ip: {127, 0, 0, 1}}
    ]

    managed_worker_children =
      if runtime.managed_worker_count > 0 do
        Enum.map(1..runtime.managed_worker_count, fn index ->
          Supervisor.child_spec({VilanoKernel.ManagedWorker, index}, id: {:managed_worker, index})
        end)
      else
        []
      end

    children = core_children ++ managed_worker_children

    Supervisor.init(children, strategy: :one_for_one)
  end
end
