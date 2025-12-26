App({
  onLaunch() {
    if (wx.cloud && typeof wx.cloud.init === "function") {
      wx.cloud.init({
        env: 'your-cloud-env-id', 
        traceUser: true,
});
    }
  }
});
