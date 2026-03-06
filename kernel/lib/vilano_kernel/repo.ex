defmodule VilanoKernel.Repo do
  use Ecto.Repo,
    otp_app: :vilano_kernel,
    adapter: Ecto.Adapters.SQLite3
end
