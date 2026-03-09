defmodule VilanoKernel.ConfigTest do
  use ExUnit.Case, async: true

  test "loads MIX_ENV-specific config" do
    {config, _imports} =
      Config.Reader.read_imports!(
        Path.expand("../config/config.exs", __DIR__),
        env: :test
      )

    assert config[:vilano_kernel][:test_config_loaded]
  end
end
