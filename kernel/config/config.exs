import Config

config :vilano_kernel,
  ecto_repos: [VilanoKernel.Repo]

import_config "#{config_env()}.exs"
