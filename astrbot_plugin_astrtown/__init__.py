"""AstrTown Platform Adapter plugin for AstrBot.

This plugin registers:
- Platform adapter: astrtown
- LLM tools for controlling NPC through Gateway
"""

from .main import AstrTownPlugin

__all__ = ["AstrTownPlugin"]
