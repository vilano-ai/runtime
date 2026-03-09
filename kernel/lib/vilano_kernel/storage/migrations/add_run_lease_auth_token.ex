defmodule VilanoKernel.Storage.Migrations.AddRunLeaseAuthToken do
  @moduledoc false

  def version, do: 7
  def name, do: "add_run_lease_auth_token"

  def up do
    VilanoKernel.Storage.ensure_column!("runs", "lease_auth_token", "text")
  end
end
