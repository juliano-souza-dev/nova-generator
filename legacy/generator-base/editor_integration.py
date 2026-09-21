"""Register Frame Lab on the existing Generator server without replacing its home."""
from fastapi.responses import FileResponse
from fastapi.routing import APIRoute
import editor_server


def install_editor(app):
    @app.get('/editor',include_in_schema=False)
    def editor_page():
        return FileResponse(editor_server.ROOT/'static/editor/index.html')

    # Reuse the tested API; Generator already owns /static and the project home.
    app.router.routes.extend(route for route in editor_server.app.routes
                             if isinstance(route,APIRoute) and route.path.startswith('/api/editor/'))
