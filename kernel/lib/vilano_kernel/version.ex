defmodule VilanoKernel.Version do
  @moduledoc false

  @protocol_version 2

  def runtime_version do
    :vilano_kernel
    |> Application.spec(:vsn)
    |> to_string()
  end

  def protocol_version, do: @protocol_version
end
