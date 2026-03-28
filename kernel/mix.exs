defmodule VilanoKernel.MixProject do
  use Mix.Project

  def project do
    [
      app: :vilano_kernel,
      version: "0.1.3",
      elixir: "~> 1.17",
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {VilanoKernel.Application, []}
    ]
  end

  defp deps do
    [
      {:bandit, "~> 1.10.3"},
      {:plug, "~> 1.19.1"},
      {:ecto_sql, "~> 3.13.5"},
      {:ecto_sqlite3, "~> 0.22.0"},
      {:jason, "~> 1.4.4"}
    ]
  end
end
