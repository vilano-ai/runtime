defmodule VilanoKernel.Runtime do
  @moduledoc false

  defstruct [:home_dir, :runtime_db_path, :port, :started_at]

  def load! do
    home_dir =
      System.get_env("VILANO_HOME") ||
        Path.join(System.user_home!(), ".vilano")

    port =
      case System.get_env("VILANO_KERNEL_PORT", "4141") do
        value when is_binary(value) ->
          String.to_integer(value)
      end

    %__MODULE__{
      home_dir: home_dir,
      runtime_db_path: Path.join(home_dir, "runtime.sqlite"),
      port: port,
      started_at: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
    }
  end
end
