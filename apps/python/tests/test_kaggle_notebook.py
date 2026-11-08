import json
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[3]
NOTEBOOK_PATH = ROOT_DIR / "notebooks" / "kaggle-qwen-coder.ipynb"
PREP_NOTEBOOK_PATH = ROOT_DIR / "notebooks" / "kaggle-prepare-qwen-dataset.ipynb"


class KaggleNotebookTests(unittest.TestCase):
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

    def test_kaggle_runtime_and_single_gpu_configuration(self):
        sources = "\n".join(self.cells_by_id.values())
        self.assertIn("/kaggle/input/qwen25-coder-3b-instruct", sources)
        self.assertIn('device_map={"": 0}', sources)
        self.assertIn("local_files_only=True", sources)
        self.assertNotIn("google.colab", sources)
        self.assertNotIn("runtime.unassign", sources)
        self.assertIn("Stop Session", sources)
        self.assertNotIn("30 hours per week", sources)

    def test_benchmark_warms_before_timed_generation(self):
        benchmark = self.cells_by_id["kaggle-inference"]
        warmup = benchmark.index("max_new_tokens=1")
        synchronization = benchmark.index("torch.cuda.synchronize()", warmup)
        reset_peaks = benchmark.index("torch.cuda.reset_peak_memory_stats(0)")
        timer = benchmark.index("started = time.perf_counter()")
        timed_generation = benchmark.index("max_new_tokens=220")

        self.assertLess(warmup, synchronization)
        self.assertLess(synchronization, reset_peaks)
        self.assertLess(reset_peaks, timer)
        self.assertLess(timer, timed_generation)
        self.assertIn("torch.cuda.max_memory_allocated(0)", benchmark)
        self.assertIn("torch.cuda.max_memory_reserved(0)", benchmark)

    def test_cpu_dataset_prep_notebook_compiles_and_verifies_snapshot(self):
        with PREP_NOTEBOOK_PATH.open(encoding="utf-8") as notebook_file:
            notebook = json.load(notebook_file)
        code_cells = [
            cell for cell in notebook["cells"] if cell["cell_type"] == "code"
        ]
        self.assertTrue(code_cells)
        for index, cell in enumerate(code_cells):
            with self.subTest(cell=index, cell_id=cell.get("id")):
                compile(
                    "".join(cell["source"]),
                    f"{PREP_NOTEBOOK_PATH}:cell {index}",
                    "exec",
                )
        sources = "\n".join(
            "".join(cell["source"]) for cell in notebook["cells"]
        )
        self.assertIn("/kaggle/working/qwen2.5-coder-3b-instruct", sources)
        self.assertIn("snapshot_download", sources)
        self.assertIn("config.json", sources)
        self.assertIn("*.safetensors", sources)
        self.assertNotIn("torch.cuda", sources)
        self.assertIn("private Kaggle Dataset", sources)


if __name__ == "__main__":
    unittest.main()
