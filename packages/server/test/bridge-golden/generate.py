"""Generate RFutils' bridge golden fixtures from wsm-wwb-bridge itself.

    python3 generate.py <wsm-wwb-bridge checkout> <output dir>

Run it from a scratch directory, not inside either repository, then copy the
output dir's contents here (packages/server/test/bridge-golden/).

For every input below, run the bridge's own Python: detect the format, read it
with the reader the bridge's GUI would pick, and write it back out with each of
the bridge's four writers. The result is one <name>.expected.json per input,
next to a copy of the input; packages/server/test/bridgeGolden.test.ts asserts
RFutils produces exactly the same.

Inputs are only what the bridge publishes in its repository — its sample_data/
files and the sample documents inlined in its tests — plus a few small
synthetic files written here to pin the two known parity edges (round-half-
even, and "G: 01 Ch: 05"). Never its gitignored sample_data/real/.

Generated from wsm-wwb-bridge 0544608 (v1.1.2) with Python 3.14. The wsm-csv
outputs were edited by hand afterwards, on purpose; bridgeGolden.test.ts says
how and why, and a regenerate has to put that back.
"""
import importlib
import json
import os
import sys

bridge, out = sys.argv[1], sys.argv[2]
sys.path.insert(0, bridge)

from wsm_wwb_bridge.csv_generic import parse_generic_csv, write_generic_csv  # noqa: E402
from wsm_wwb_bridge.detect import detect_format  # noqa: E402
from wsm_wwb_bridge.wsm import read_wsm_csv, write_wsm_csv  # noqa: E402
from wsm_wwb_bridge.wsm_html import read_wsm_html_report  # noqa: E402
from wsm_wwb_bridge.wsm_xml import read_wsm_project  # noqa: E402
from wsm_wwb_bridge.wwb import (  # noqa: E402
    read_wwb_file,
    write_wwb_frequency_list,
    write_wwb_inventory_csv,
)
from wsm_wwb_bridge.wwb_report import read_wwb_report_csv  # noqa: E402
from wsm_wwb_bridge.wwb_xml import read_wwb_xml  # noqa: E402

READERS = {
    "wsm": read_wsm_csv,
    "wwb-xml": read_wwb_xml,
    "wwb-report": read_wwb_report_csv,
    "wsm-xml": read_wsm_project,
    "wsm-html": read_wsm_html_report,
    "wwb-frequency-list": read_wwb_file,
    "generic": parse_generic_csv,
}
WRITERS = {
    "wwb-frequency-list": write_wwb_frequency_list,
    "wwb-inventory-csv": write_wwb_inventory_csv,
    "wsm-csv": write_wsm_csv,
    "generic-csv": write_generic_csv,
}
FIELDS = [
    ("name", "name"),
    ("frequency_mhz", "frequencyMhz"),
    ("group", "group"),
    ("channel", "channel"),
    ("device_type", "deviceType"),
    ("manufacturer", "manufacturer"),
    ("notes", "notes"),
    ("zone", "zone"),
    ("inclusion_group", "inclusionGroup"),
    ("is_backup", "isBackup"),
]

inputs = {}

# 1. The bridge's committed sample_data/ files.
for name in sorted(os.listdir(os.path.join(bridge, "sample_data"))):
    path = os.path.join(bridge, "sample_data", name)
    if os.path.isfile(path):
        with open(path, encoding="utf-8-sig", newline="") as f:
            inputs[name] = f.read()

# 2. The sample documents inlined in the bridge's own tests.
INLINE = [
    ("tests.test_wwb_xml", "SAMPLE_SHW", "test_wwb_xml.SAMPLE_SHW.shw"),
    ("tests.test_wwb_xml", "SAMPLE_SHW_NO_INVENTORY", "test_wwb_xml.SAMPLE_SHW_NO_INVENTORY.shw"),
    ("tests.test_wwb_xml", "SAMPLE_CWS", "test_wwb_xml.SAMPLE_CWS.cws"),
    ("tests.test_wsm_xml", "SAMPLE_WSM", "test_wsm_xml.SAMPLE_WSM.wsm"),
    ("tests.test_wsm_xml", "SAMPLE_WSM_NO_COORDINATION", "test_wsm_xml.SAMPLE_WSM_NO_COORDINATION.wsm"),
    ("tests.test_wsm_html", "SAMPLE_REPORT", "test_wsm_html.SAMPLE_REPORT.html"),
    ("tests.test_wwb_report", "SAMPLE_REPORT", "test_wwb_report.SAMPLE_REPORT.csv"),
]
for module, attr, name in INLINE:
    inputs[name] = getattr(importlib.import_module(module), attr)

# ...and the one-line ones its detect/reader tests use.
inputs["test_detect.wsm_csv.csv"] = (
    "name;type;frequency;tolerance;minfrequency;maxfrequency;priority;squelchlevel\n"
    "Frequency 001;0;510100;0;510100;510100;2;5\n"
)
inputs["test_wsm.band_shape.csv"] = (
    "name;type;frequency;tolerance;minfrequency;maxfrequency;priority;squelchlevel\n"
    "Band 001;2;705000;0;400000;4000000;2;5\n"
)
inputs["test_wwb.comma_separated_bare_list.txt"] = "470.100,471.100,472.100"
inputs["test_wwb.structured_csv.csv"] = "Name,Frequency\nLead Vocal,470.100\nHost Mic,471.100\n"
inputs["test_detect.unrecognized_generic.csv"] = (
    "Talent,Freq (MHz),Zone,Ch,Device,Brand\nLead Vocal,606.250,A,1,ULXD2,Shure\n"
)

# 3. Synthetic: the two parity edges RFutils used to get wrong.
inputs["synthetic.round_half_even.csv"] = (
    "Name,Frequency,Group,Channel,Type,Manufacturer,Notes,Zone\n"
    "Tie low,512.0625,1,1,ULXD2,Shure,exact sixteenth,A\n"
    "Tie high,470.1875,1,2,ULXD2,Shure,exact sixteenth,A\n"
    "Tie even,606.3125,1,3,ULXD2,Shure,exact sixteenth,A\n"
    "Not a tie,614.1005,1,4,ULXD2,Shure,decimal 5 is not exact in binary,B\n"
    "Plain,630.900,2,1,PSM1000,Shure,,B\n"
)
inputs["synthetic.wwb_report_spaced_group_channel.csv"] = (
    "Coordination report\n\n"
    "RF zone: Stage\n\n"
    "Primary frequencies (2)\n"
    "Type,Band,Channel name,Group & Channel,Frequency,\n"
    "No Inclusion Group (2),,,,,\n"
    "AD/Standard,G56,Lead Vox,G: 01 Ch: 05,512.0625 MHz,\n"
    "AD/Standard,G56,,G:2 Ch:7,470.1875 MHz,\n\n"
    "Backup frequencies (1)\n"
    "Type,Band,Source,Group & Channel,Frequency,\n"
    "No Inclusion Group (1),,,,,\n"
    "AD/Standard,G56,,G: -- Ch: --,606.3125 MHz,\n"
)

os.makedirs(out, exist_ok=True)
for name, text in sorted(inputs.items()):
    with open(os.path.join(out, name), "w", encoding="utf-8", newline="") as f:
        f.write(text)
    fmt = detect_format(text)
    try:
        cl = READERS[fmt](text)
    except Exception as e:  # noqa: BLE001 - recorded, and asserted on the TS side
        expected = {"input": name, "format": fmt, "error": f"{type(e).__name__}: {e}"}
    else:
        expected = {
            "input": name,
            "format": fmt,
            "list": {
                "sourceFormat": cl.source_format,
                "channels": [{ts: getattr(ch, py) for py, ts in FIELDS} for ch in cl],
            },
            "outputs": {fid: w(cl) for fid, w in WRITERS.items()},
        }
    with open(os.path.join(out, name + ".expected.json"), "w", encoding="utf-8") as f:
        json.dump(expected, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"{name}: {fmt}, {len(expected.get('list', {}).get('channels', []))} channels")
