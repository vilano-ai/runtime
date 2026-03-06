defmodule VilanoKernel.MixProject do
  use Mix.Project

  def project do
    [
      app: :vilano_kernel,
      version: "0.1.0",
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      deps: []
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {VilanoKernel.Application, []}
    ]
  end
end
