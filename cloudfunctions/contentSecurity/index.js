const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

function getErrCode(result) {
  if (!result) return null;
  if (typeof result.errCode === "number") return result.errCode;
  if (typeof result.errcode === "number") return result.errcode;
  return null;
}

function getErrMsg(result) {
  if (!result) return "";
  return result.errMsg || result.errmsg || "";
}

exports.main = async (event) => {
  const action = event && event.action ? String(event.action) : "";
  if (action !== "image") {
    return { ok: false, status: "error", errMsg: "unsupported action" };
  }

  const fileID = event && event.fileID ? String(event.fileID) : "";
  if (!fileID) {
    return { ok: false, status: "error", errMsg: "missing fileID" };
  }

  const contentType = event && event.contentType ? String(event.contentType) : "image/jpeg";

  try {
    const download = await cloud.downloadFile({ fileID });
    const buffer = download && download.fileContent ? download.fileContent : null;
    if (!buffer) {
      return { ok: false, status: "error", errMsg: "empty file content" };
    }

    const checkRes = await cloud.openapi.security.imgSecCheck({
      media: {
        contentType,
        value: buffer
      }
    });

    const errCode = getErrCode(checkRes);
    let status = "pass";
    if (errCode === 0 || errCode === null) {
      status = "pass";
    } else if (errCode === 87014) {
      status = "reject";
    } else {
      status = "error";
    }

    return {
      ok: status === "pass",
      status,
      errCode,
      errMsg: getErrMsg(checkRes)
    };
  } catch (err) {
    return {
      ok: false,
      status: "error",
      errCode: getErrCode(err),
      errMsg: getErrMsg(err) || String(err && err.message ? err.message : err)
    };
  } finally {
    try {
      await cloud.deleteFile({ fileList: [fileID] });
    } catch (e) {
      // ignore cleanup failures
    }
  }
};
