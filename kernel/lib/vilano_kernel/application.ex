defmodule VilanoKernel.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      VilanoKernel.RuntimeSupervisor
    ]

    Supervisor.start_link(children, strategy: :one_for_one, name: VilanoKernel.Supervisor)
  end
end
