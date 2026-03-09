defmodule VilanoKernel.StorageBootstrap do
  @moduledoc false

  use GenServer

  alias VilanoKernel.Storage

  def start_link(_arg) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  @impl true
  def init(state) do
    Storage.init!()
    {:ok, state}
  end
end
