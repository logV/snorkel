module.exports = {
  sockets: true,
  udp: {
    port: 59036
  },
  authorized_users: "config/users.htpasswd",
  http_port: 3000,
  max_http_sockets: 1000,
  hostname: "localhost",
  behind_proxy: false,
  // This is the default max data size of the collection. Each dataset will
  // only grow to this size and no further, ideally
  default_max_dataset_size: 1024 * 1024 * 100 // 100 MB
};
