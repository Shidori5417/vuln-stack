defmodule Demo.MixProject do
  use Mix.Project

  def project do
    [app: :demo, version: "0.1.0", deps: deps()]
  end

  defp deps do
    [
      {:phoenix, "~> 1.5.0"},
      {:plug_cowboy, "~> 2.0"},
      {:jason, "~> 1.2"},
      {:ex_doc, "~> 0.23", only: :dev, runtime: false}
    ]
  end
end
