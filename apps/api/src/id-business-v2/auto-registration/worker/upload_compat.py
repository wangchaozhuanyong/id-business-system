"""Name compatibility for the frozen registration upload entry point."""

import importlib


def install_upload_compatibility() -> None:
    module = importlib.import_module("src.core.upload.team_manager_upload")
    # The frozen registration route imports this name while the frozen upload
    # module exports upload_to_team_manager with the same three arguments.
    # Alias the actual implementation; preserve its request and failure result.
    if not hasattr(module, "upload_account_to_tm"):
        module.upload_account_to_tm = module.upload_to_team_manager
