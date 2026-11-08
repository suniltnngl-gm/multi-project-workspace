import json
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
NOTEBOOK_PATH = ROOT_DIR / "notebooks" / "colab-qwen-coder-free-tier.ipynb"


class ColabNotebookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with NOTEBOOK_PATH.open(encoding="utf-8") as notebook_file:
            cls.notebook = json.load(notebook_file)
        cls.cells_by_id = {
            cell.get("id"): "".join(cell.get("source", []))
            for cell in cls.notebook["cells"]
        }

    def test_notebook_code_cells_compile(self):
        code_cells = [
            cell for cell in self.notebook["cells"] if cell["cell_type"] == "code"
        ]
        self.assertTrue(code_cells)
        for index, cell in enumerate(code_cells):
            with self.subTest(cell=index, cell_id=cell.get("id")):
                compile("".join(cell["source"]), f"{NOTEBOOK_PATH}:cell {index}", "exec")

    def test_benchmark_warms_before_timed_generation(self):
        benchmark = self.cells_by_id["6a404461"]
        warmup = benchmark.index("max_new_tokens=1")
        synchronization = benchmark.index("torch.cuda.synchronize()", warmup)
        reset_peaks = benchmark.index("torch.cuda.reset_peak_memory_stats()")
        timer = benchmark.index("started = time.perf_counter()")
        timed_generation = benchmark.index("max_new_tokens=220")

        self.assertLess(warmup, synchronization)
        self.assertLess(synchronization, reset_peaks)
        self.assertLess(reset_peaks, timer)
        self.assertLess(timer, timed_generation)
        self.assertIn("with torch.inference_mode(): warmup_output = model.generate", benchmark)
        self.assertIn("with torch.inference_mode(): output = model.generate", benchmark)
        self.assertIn("torch.cuda.max_memory_allocated()", benchmark)
        self.assertIn("torch.cuda.max_memory_reserved()", benchmark)


if __name__ == "__main__":
    unittest.main()
