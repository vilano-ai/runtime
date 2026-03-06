defmodule VilanoKernel.RuntimeSupervisor do
  @moduledoc """
  Top-level supervisor placeholder for the v1 kernel process tree.
  """

  use Supervisor

  @impl true
  def start_link(arg) do
    Supervisor.start_link(__MODULE__, arg, name: __MODULE__)
  end

  @impl true
  def init(_arg) do
    children = []

    Supervisor.init(children, strategy: :one_for_one)
  end
end
