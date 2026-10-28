import argparse

import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PeopleLens local Python web application")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run("people_counter.app:app", host=args.host, port=args.port,
                ws_max_size=2 * 1024 * 1024, timeout_graceful_shutdown=15)
